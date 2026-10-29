/**
 * Verificação independente da cadeia de lances, no navegador (WebCrypto).
 *
 * Modelo (backend/src/common/crypto/audit-crypto.ts):
 *   genesisHash = SHA-256(genesisPayload)
 *   bid.hash    = SHA-256(bid.payload)   payload = JSON ["BID", lotId, seq, alias, amount, createdAt, prevHash]
 *   bid.signature = Ed25519(texto do hash em hex)
 *   headSignature = Ed25519(JSON ["HEAD", lotId, bidCount, headHash])
 *
 * Importante: o navegador só faz hash do TEXTO recebido (`genesisPayload`, `bid.payload`);
 * nunca reconstrói o payload a partir dos campos. Assim, se o back incluir novos campos
 * no payload (ex.: imageUrl/attributes na gênese), nada muda aqui. Os campos exibidos
 * (valor, pseudônimo, horário) são apenas COMPARADOS com o payload em `payloadMatches`.
 */
import type { AuditReport } from './types';

export interface BrowserBidCheck {
  sequence: number;
  hashOk: boolean;
  linkOk: boolean;
  fieldsOk: boolean;
  signatureOk: boolean | null; // null = não verificado (sem suporte a Ed25519)
}

export interface BrowserReport {
  ed25519Supported: boolean;
  genesisOk: boolean;
  headOk: boolean | null;
  /** null = lote não cancelado (ou sem chave para conferir) */
  cancelOk: boolean | null;
  bids: BrowserBidCheck[];
  issues: string[];
  ok: boolean;
}

const enc = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importEd25519(rawB64: string): Promise<CryptoKey | null> {
  try {
    return await crypto.subtle.importKey('raw', b64ToBytes(rawB64), { name: 'Ed25519' }, false, ['verify']);
  } catch {
    return null;
  }
}

async function verifyEd25519(key: CryptoKey, signatureB64: string, text: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, b64ToBytes(signatureB64), enc.encode(text));
  } catch {
    return false;
  }
}

function payloadMatches(payload: string, b: AuditReport['bids'][number], lotId: string): boolean {
  try {
    const p = JSON.parse(payload) as unknown[];
    return (
      Array.isArray(p) &&
      p[0] === 'BID' &&
      p[1] === lotId &&
      p[2] === b.sequence &&
      p[3] === b.bidderAlias &&
      p[4] === b.amountCents &&
      typeof p[5] === 'string' &&
      Date.parse(p[5] as string) === Date.parse(b.createdAt) &&
      p[6] === b.prevHash
    );
  } catch {
    return false;
  }
}

/** Chave Ed25519 crua: 32 bytes em base64. */
function isRawEd25519Key(rawB64: string): boolean {
  try {
    return b64ToBytes(rawB64).length === 32;
  } catch {
    return false;
  }
}

/**
 * `expectedLotId` é o id da URL, não o do relatório: um servidor que responda com outro
 * lote (ou reescreva a cadeia sob outro id) não pode passar como "tudo confere".
 */
export async function verifyInBrowser(report: AuditReport, expectedLotId: string): Promise<BrowserReport> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('Este navegador não oferece WebCrypto (é preciso HTTPS ou localhost).');
  }
  const issues: string[] = [];
  const lotId = expectedLotId;
  const idOk = report.lot.id === lotId;
  if (!idOk) issues.push('O relatório recebido é de outro lote, não do endereço que você abriu.');

  const keyValid = isRawEd25519Key(report.publicKey.publicKeyRawBase64);
  if (!keyValid) issues.push('A chave pública enviada pelo servidor é inválida: as assinaturas não puderam ser conferidas.');
  const key = keyValid ? await importEd25519(report.publicKey.publicKeyRawBase64) : null;
  // Chave válida que o navegador não importa = sem suporte a Ed25519 (não é divergência).
  const ed25519Supported = !keyValid || key !== null;

  let genesisOk = (await sha256Hex(report.genesisPayload)) === report.lot.genesisHash;
  try {
    const g = JSON.parse(report.genesisPayload) as unknown[];
    genesisOk = genesisOk && Array.isArray(g) && g[0] === 'GENESIS' && g[1] === lotId;
  } catch {
    genesisOk = false;
  }
  if (!genesisOk) issues.push('O hash de abertura (gênese) não corresponde aos parâmetros do lote.');

  const bids: BrowserBidCheck[] = [];
  let prev = report.lot.genesisHash;
  for (let i = 0; i < report.bids.length; i++) {
    const b = report.bids[i];
    const hashOk = (await sha256Hex(b.payload)) === b.hash;
    const linkOk = b.prevHash === prev && b.sequence === i + 1;
    const fieldsOk = payloadMatches(b.payload, b, lotId);
    const signatureOk = key ? await verifyEd25519(key, b.signature, b.hash) : null;
    if (!hashOk) issues.push(`Lance #${b.sequence}: o hash não confere com o conteúdo.`);
    if (!linkOk) issues.push(`Lance #${b.sequence}: não está encadeado ao lance anterior.`);
    if (!fieldsOk) issues.push(`Lance #${b.sequence}: valor, pseudônimo ou horário exibidos diferem do conteúdo assinado.`);
    if (signatureOk === false) issues.push(`Lance #${b.sequence}: assinatura inválida.`);
    bids.push({ sequence: b.sequence, hashOk, linkOk, fieldsOk, signatureOk });
    prev = b.hash;
  }

  // O head assinado é o que denuncia lances removidos do fim: ausente = falha, não "pulado".
  let headOk: boolean | null = null;
  if (key) {
    const headHash = report.lot.headHash;
    const headPayload = JSON.stringify(['HEAD', lotId, report.bids.length, headHash]);
    headOk = !!report.lot.headSignature && headHash === prev && (await verifyEd25519(key, report.lot.headSignature, headPayload));
    if (!headOk) issues.push('A assinatura do último elo não confere: algum lance pode ter sido removido do fim.');
  }
  // Cancelamento: a assinatura cobre (lote, data, nº de lances, head) — conferida aqui também.
  let cancelOk: boolean | null = null;
  if (report.lot.cancelled || report.lot.cancelSignature || report.lot.cancelPayload) {
    let payloadOk = false;
    try {
      const c = JSON.parse(report.lot.cancelPayload ?? 'null') as unknown[];
      payloadOk =
        Array.isArray(c) &&
        c[0] === 'CANCEL' &&
        c[1] === lotId &&
        typeof c[2] === 'string' &&
        Date.parse(c[2]) === Date.parse(report.lot.cancelledAt ?? '') &&
        c[3] === report.bids.length &&
        c[4] === report.lot.headHash;
    } catch {
      payloadOk = false;
    }
    if (key) {
      cancelOk =
        report.lot.cancelled &&
        payloadOk &&
        !!report.lot.cancelSignature &&
        (await verifyEd25519(key, report.lot.cancelSignature, report.lot.cancelPayload!));
      if (!cancelOk) issues.push('O cancelamento não confere com a assinatura (data, lances ou último elo divergentes).');
    }
  }
  if (report.lot.bidCount !== report.bids.length) {
    issues.push(`O lote declara ${report.lot.bidCount} lances, mas a cadeia tem ${report.bids.length}.`);
  }

  // "ok" só com as assinaturas de fato conferidas: sem chave, nunca vira "tudo confere".
  const ok =
    idOk &&
    key !== null &&
    genesisOk &&
    headOk === true &&
    cancelOk !== false &&
    report.lot.bidCount === report.bids.length &&
    bids.every((b) => b.hashOk && b.linkOk && b.fieldsOk && b.signatureOk === true);

  return { ed25519Supported, genesisOk, headOk, cancelOk, bids, issues, ok };
}
