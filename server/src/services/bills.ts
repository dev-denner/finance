/**
 * Módulo 1 — Contas a pagar. Ponto de entrada; a implementação fica em
 * `services/bills/*`:
 *  - recurrence.ts   regras de recorrência (puro)
 *  - templates.ts    recorrências e geração idempotente de ocorrências
 *  - occurrences.ts  CRUD, agendamento, pular e pagamento das ocorrências
 *  - queries.ts      listagem por período e agenda (atrasadas/hoje/próximas)
 *  - dto.ts          tipos e derivação de status
 *  - legacy.ts       compatibilidade temporária com a tela atual
 */
export * from './bills/dto';
export * from './bills/recurrence';
export * from './bills/occurrences';
export * from './bills/templates';
export * from './bills/queries';
export * from './bills/legacy';

