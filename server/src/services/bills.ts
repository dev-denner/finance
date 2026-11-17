/**
 * Módulo 1 — Contas a pagar. Ponto de entrada; a implementação fica em
 * `services/bills/*`:
 *  - recurrence.ts   regras de recorrência (puro)
 *  - templates.ts    recorrências e geração idempotente de ocorrências
 *  - occurrences.ts  CRUD, agendamento e pular das ocorrências
 *  - payments.ts     pagar (externo, com lançamento, vinculando lançamento) e desfazer
 *  - bulk.ts         pagar ou pular várias ocorrências de uma vez
 *  - attachments.ts  anexos (boleto em PDF, foto da conta)
 *  - boleto-reader.ts  ler um boleto em PDF e sugerir a conta (valor, vencimento, descrição, categoria)
 *  - guards.ts       proteções do vínculo conta ↔ lançamento (usadas pelo Módulo 2)
 *  - queries.ts      listagem por período e agenda (atrasadas/hoje/próximas)
 *  - dto.ts          tipos e derivação de status
 */
export * from './bills/dto';
export * from './bills/recurrence';
export * from './bills/occurrences';
export * from './bills/payments';
export * from './bills/bulk';
export * from './bills/attachments';
export * from './bills/boleto-reader';
export * from './bills/guards';
export * from './bills/templates';
export * from './bills/queries';

