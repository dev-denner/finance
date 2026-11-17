/**
 * Importação de movimentações (CSV/Excel). Ponto de entrada; a implementação
 * fica em `services/import/*`:
 *  - types.ts       constantes, campos e tipos da prévia e da importação
 *  - workbook.ts    leitura do arquivo (CSV com detecção de codificação e delimitador, Excel)
 *  - mapping.ts     reconhecimento das colunas pelo cabeçalho
 *  - parse-row.ts   interpretação de cada linha (datas, valor, parcelas, transferência)
 *  - duplicates.ts  impressão digital e comparação com o banco
 *  - decisions.ts   decisões de categoria e forma de pagamento
 *  - candidates.ts  transferências e contas a pagar sugeridas
 *  - preview.ts     prévia (nada é gravado)
 *  - commit.ts      gravação do lote e histórico
 *  - templates.ts   modelos de mapeamento salvos
 */
export { IMPORT_FIELDS, REQUIRED_FIELDS, FIELD_LABELS, DEFAULT_TRANSFER_TOLERANCE_DAYS } from './import/types';
export type { ImportField, ColumnMapping, TransferDecision, CellMeta, SheetRow, ParsedWorkbook, PurchaseDateSource, ParsedImportValues, FieldIssue, RowSuggestion, DuplicateCounterpart, DuplicateInfo, PreviewRow, ImportPreview, ImportOverrides, CategoryDecisionAction, CategoryDecision, CategoryDecisions, ImportOptions, ImportSummary, PreviewOptions } from './import/types';
export { decodeCsv, readWorkbook } from './import/workbook';
export { suggestMappingDetailed, suggestMapping } from './import/mapping';
export type { MappingWarning, MappingSuggestion } from './import/mapping';
export { parseRowFields } from './import/parse-row';
export { transactionFingerprint, probableDuplicateKey } from './import/duplicates';
export { previewImport } from './import/preview';
export { importWorkbook, listImportBatches } from './import/commit';
export { listMappingTemplates, saveMappingTemplate, deleteMappingTemplate } from './import/templates';
export type { ImportMappingTemplate } from './import/templates';
