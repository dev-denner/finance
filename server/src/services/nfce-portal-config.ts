/**
 * Canal opcional de consulta automática aos portais da SEFAZ (QR Code e lote
 * de URLs), que abre um Chrome headless. Fica desligado por padrão porque
 * depende do layout dos portais e pode parar sem aviso (ressalva R2 da revisão
 * do Módulo 3). PDF e texto copiado continuam sendo os caminhos principais.
 */
import { HttpError } from '../lib/errors';

export const NFCE_PORTAL_QUERY_ENV = 'NFCE_PORTAL_QUERY_ENABLED';

export function isNfcePortalQueryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[NFCE_PORTAL_QUERY_ENV] ?? '').trim().toLowerCase() === 'true';
}

export function nfcePortalQueryDisabledError(): HttpError {
  return new HttpError(
    403,
    'A consulta automática aos portais da SEFAZ está desligada. Importe a nota pelo PDF ou pelo texto copiado, '
      + `ou ative ${NFCE_PORTAL_QUERY_ENV}=true no .env.`,
  );
}
