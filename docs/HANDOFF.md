# HANDOFF — estado do projeto Finance e como continuar

Atualizado em 2026-11-11 (sessão com Claude Fable 5.1; PR2 e PR3 adicionados na sessão com Claude Opus 5.5). Leia este arquivo antes de qualquer trabalho; ele resume o que já foi decidido, feito e o que falta, com ponteiros para os documentos detalhados. Os documentos de referência estão em `docs/`:

| Documento | Conteúdo |
|---|---|
| `docs/analise-modulos-2026-11.md` | Análise do repositório, avaliação da pasta `.opencode`, problemas e propostas por módulo, arquitetura de monorepo e priorização |
| `docs/plano-modulo-1-contas-a-pagar.md` | Plano do Módulo 1 no formato do `planner.md` (21 critérios de aceite, contratos, migração, 6 PRs) + registro de execução do PR1 |
| `docs/revisao-modulo-3-2026-11.md` | Revisão da branch `feat/module3-purchases` (veredito, ressalvas R1–R7, ordem de merge) |
| `docs/referencias/` | Duas imagens de referência visual de terceiros (dashboard de transações; orçamento anual do app Spendle) |

## 1. O projeto em uma página

App local (sem login, sem cloud) para substituir a planilha financeira do usuário. Quatro módulos:

1. **Contas a pagar** (agenda de pagamentos, não razão contábil) — em evolução nesta frente.
2. **Movimentações** (lançamentos, importação CSV/XLSX, transferências, categorias, consolidado anual) — o mais maduro.
3. **Compras / NFC-e** — implementado na branch `origin/feat/module3-purchases` (ainda não mesclada quando este arquivo foi escrito).
4. **Produtos** (normalização de itens de compra, preço por unidade, histórico por fornecedor) — não iniciado; só depois de 1–3 estarem estáveis.

Stack: TypeScript strict, Fastify 5, React 19 + Vite 7, Tailwind 3, SQLite (`better-sqlite3`) + Drizzle, Zod nas rotas, Vitest. Monorepo npm workspaces (`server/`, `client/`). Regras do repositório em `AGENTS.md` (comandos reais, gate de qualidade, proibições: sem dependência nova sem aprovação, sem push sem aprovação, Conventional Commits com Gitmoji).

## 2. Estado das branches (2026-11-11)

| Branch | Onde | Estado |
|---|---|---|
| `origin/master` (7676fe5) | remoto | Contém PR 2 (importação com decisões de categoria), PR 3 (lembretes por e-mail para contas a pagar, migração `0006_slimy_nekra`), PR 4 (OpenCode simplificado). Baseline declarado no `AGENTS.md`: 362 testes |
| `origin/feat/module3-purchases` (5c03ee6) | remoto | Módulo 3 completo: 3 commits grandes, migrações `0007`–`0014`, build e 418+53 testes verdes. **Revisado, aprovado com ressalvas**, aguardando merge |
| `feat/bills-recurrence` | **local apenas** | Fase 0 + PR1 do Módulo 1: 7 commits sobre `origin/master` (CI, imagens movidas, docs, feat(bills) com migração `0007_bill_templates_and_payments`, docs de baseline, revisão do M3). Build verde; 383 testes server + 26 client. **Nenhum PR aberto, nada enviado** |
| `feat/bills-payments` | **local apenas** | PR2 do Módulo 1, empilhada sobre `feat/bills-recurrence`: pagar com lançamento e vínculo, guards no Módulo 2. Build verde; 400 testes server + 26 client. Abrir PR só depois do PR1 |
| `feat/bills-api` | **local apenas** | PR3, empilhada sobre `feat/bills-payments`: rotas Zod de ocorrências e recorrências, multipart compartilhado, cliente tipado. Build verde; 412 testes server + 26 client |
| `feat/bills-recurrence-oldbase` | local | Backup do mesmo trabalho sobre a base antiga. Pode ser apagada |
| `feat/import-installments-category-matching` | local | Base antiga com commits duplicados do que já está em `origin/master`. Pode ser apagada |

O usuário trabalha em mais de uma máquina (Windows e Linux) e com sessões paralelas de IA que fazem merge no remoto. **Sempre `git fetch origin` e criar branches a partir de `origin/master`.**

## 3. Decisões tomadas com o usuário (não reabrir sem motivo)

- **Módulo 1 é agenda de pagamentos**; a conciliação com o Módulo 2 é opcional e frouxa. "Pagar" tem três modos: `external` (só marca paga; padrão do popover), `transaction` (cria lançamento; padrão quando o template tem conta padrão) e `link` (vincula lançamento existente; usado pelo auto-match da importação).
- **Recorrência** termina por data (`endDate`) **ou** por quantidade (`occurrenceCount`); vale o que acabar primeiro. Conta avulsa nunca gera ocorrência futura. 12 meses é só o horizonte de materialização.
- **Status derivado, nunca gravado**: só `open | paid | skipped` no banco; atrasada/hoje/agendada/futura vêm de `state` + datas.
- **Manter a tabela `scheduled_bills`** como ocorrência (sem renomear). "AG" virou `scheduled_for`.
- **Excluir lançamento vinculado a pagamento é bloqueado** (mesmo padrão das transferências), não cascateado.
- **Sugestões nunca se aplicam sozinhas** (categorias, transferências, pagamentos de contas): decisão explícita na prévia.
- **Ordem de merge**: `feat/module3-purchases` entra primeiro; depois `feat/bills-recurrence` é rebaseada e a migração renumerada para `0015`.
- **Manter a stack**; o problema é organização, não tecnologia. Caminho para mobile: PWA primeiro, Expo depois, com `packages/domain` e `api-client` compartilhados (ver análise, seção 5).
- **Módulo 3 sem scraping agressivo**: a branch automatiza portais da SEFAZ com guardas (sem captcha, limites), mas a recomendação registrada é deixar esse canal opcional e priorizar texto colado e PDF.

## 4. O que foi feito nesta frente (PR1 do Módulo 1)

Serviços em `server/src/services/bills/` (barrel em `services/bills.ts`):

- `recurrence.ts` — regras puras (`nextOccurrenceDates`, `validateRecurrence`, `describeRecurrence`).
- `templates.ts` — CRUD de `bill_templates`, `ensureOccurrences` idempotente (único por `template_id + sequence`), `updateTemplate` com `scope: 'all'` (propaga campos descritivos; recusa mudar recorrência) e `scope: 'future'` (divide a série em `from`), `deleteTemplate`, `previewTemplateDates`.
- `occurrences.ts` — `createBill`/`updateBill`/`deleteBill` (ocorrência de recorrência vira `skipped` em vez de apagar), `skipBill`, `unskipBill`, `scheduleBill`, `payBill` (**só `mode: 'external'` por enquanto**), `unpayBill`.
- `queries.ts` — `listBills(year, month, {state, search, categoryId, today})`, `listBillsBetween`, `getAgenda({days, today})`; ambos chamam `ensureAllOccurrences` antes.
- `dto.ts` — `BillDto` (inclui `status` legado derivado e `payments`), `BillSummary` (`statusCounts` novo + `counts`/`unpaidCents` legados), `displayStatusOf`.
- `legacy.ts` — `setBillStatus`, `repeatBill`, `advanceMonth` sobre o modelo novo, para a tela atual e as rotas `/:id/status` e `/:id/repeat` continuarem funcionando até o PR4.

Schema/migração: `bill_templates`, `bill_payments`, `scheduled_bills` recriada (sem `status`; com `template_id`, `sequence`, `state`, `scheduled_for`, `paid_at`, `paid_cents`, `payment_method_id`, `notes`, `migrated_payment`). Migração `0007_bill_templates_and_payments.sql` copia `''/AG/PG → open/open+scheduled_for/paid+migrated_payment=1`. Lembretes por e-mail (`bill-reminders.ts`) passaram a filtrar `state = 'open' AND scheduled_for IS NULL`. Reset de dados inclui `bill_payments`, `scheduled_bills`, `bill_templates` (antes `db:reset:all` falhava por FK).

Testes novos: `bills-recurrence`, `bills-templates`, `bills-occurrences`, `bills-migration` (aplica migrações até `0006`, semeia dados legados e lembretes, aplica `0007`, confere). Os testes antigos de status/repeat continuam válidos pela camada legada.

## 5. O que falta (em ordem)

1. **Esperar o merge do Módulo 3** (decisão do usuário). Então, em `feat/bills-recurrence`: `git fetch`, rebase sobre `origin/master`, renomear `server/drizzle/0007_bill_templates_and_payments.sql` e `meta/0007_snapshot.json` para `0015_...`, corrigir `meta/_journal.json` (tag e `idx`), unir `DATA_RESET_TABLES` em `server/src/db/reset.ts` na ordem `purchase_settlements, payment_balance_adjustments, purchase_items, purchases, bill_payments, transfer_rejections, transfers, transactions, import_batches, bill_reminder_notifications, bill_reminder_batches, scheduled_bills, bill_templates`, unir `tests/reset.test.ts`, atualizar baseline no `AGENTS.md`, rodar `npm run build && npm test`. `schema.ts` e `README.md` mesclam sozinhos (verificado com `git merge-tree`). Depois abrir o PR (sem push até o usuário aprovar).
2. ~~**PR2**~~ — **feito** em `feat/bills-payments` (ver registro no plano). Após o rebase do PR1 (item 1), rebasear `feat/bills-payments` sobre a nova `feat/bills-recurrence` (`git rebase --onto`); não toca migrações.
3. ~~**PR3**~~ — **feito** em `feat/bills-api` (ver registro no plano). `/status` e `/repeat` ficaram como deprecated e saem no PR4. Ordem de rebase após o merge do Módulo 3: `feat/bills-recurrence` → `feat/bills-payments` → `feat/bills-api`.
4. **PR4** — tela nova (filas atrasadas/hoje/7 dias/mês, chip de status, popover "Pagar" com toggle "Registrar lançamento", formulário com toggle "Repetir" e prévia de 6 datas, "só esta / esta e as futuras", URL persistente, badge no menu). Remover `legacy.ts`, `status` e `counts` legados, testes antigos de status/repeat (com justificativa no commit).
5. **PR5** — auto-match de pagamentos na importação de extrato (`bill-payment-detection.ts`, `billCandidates`/`billDecisions`).
6. **PR6** — docs finais.
7. **Módulo 3, após o merge**: ressalvas R3 (conciliar sobrescreve categoria dos itens), R4 (`purchases.transaction_id` redundante), R6 (tsconfig `lib: DOM`, teste do parser RJ, mensagens em BRL), R7 (código do item e `purchase_payments` para o Módulo 4).
8. **Módulo 2** (fase 2 da análise): entidade conta evoluindo `payment_methods.balance_type`, perfis de arquivo por banco, OFX, grupo de parcelas, rateio/tags, regras, desfazer lote, quebrar `import.ts`/`TransactionsImportPage.tsx` em wizard.

## 6. Armadilhas aprendidas (evite repetir)

- **Migrator do Drizzle roda em transação**: `PRAGMA foreign_keys=OFF` gerado pelo drizzle-kit **não tem efeito**. Um rebuild de tabela (`__new_x` + `DROP` + `RENAME`) dispara `ON DELETE SET NULL/CASCADE` nos filhos e na auto-referência. Solução usada na `0007`: copiar filhos/colunas auto-referentes para tabelas auxiliares antes do `DROP` e restaurar após o `RENAME`. Teste de migração cobre isso.
- **`drizzle-kit generate` é interativo** quando há coluna removida + colunas adicionadas na mesma tabela (pergunta "rename ou nova?") e falha sem TTY. Contorno: gerar em dois passos (manter a coluna antiga, gerar; editar o SQL à mão para remover a coluna e fazer a cópia de dados; apagar a coluna do snapshot JSON; remover do `schema.ts`; `generate` deve responder "No schema changes").
- **O INSERT…SELECT gerado para rebuild seleciona colunas novas da tabela antiga** (não existem): sempre revisar e reescrever o SELECT com `CASE`/`NULL`.
- **`better-sqlite3` precisa de `npm rebuild better-sqlite3`** quando o `node_modules` veio de outro SO/Node ("Could not locate the bindings file").
- **`npx vitest run … -w`**: `-w` é **watch**, não workspace; trava o comando. Rode dentro de `server/` ou `client/`.
- **`git commit` commita tudo que está no índice**: após `git checkout <branch> -- arquivos`, os arquivos ficam staged; faça `git reset` antes de commits por unidade.
- A tela atual de contas e os lembretes dependem do campo legado `status`/`counts` do DTO até o PR4.
- O `.gitattributes` do `origin/master` já define `* text=auto eol=lf`; não renormalizar retroativamente (decisão registrada lá).

## 7. Ambiente e comandos

- Node 24, npm workspaces. `npm install` → `npm run build` → `npm test` (gate). `npm run db:backup` antes de qualquer migração. `npm run dev` sobe API em 3001 e web em 5173.
- Baseline de testes ao fim do PR1: 383 server + 26 client (409); ao fim do PR2: 400 + 26 (426); ao fim do PR3: 412 + 26 (438). Na branch do Módulo 3: 418 + 53.
- CI em `.github/workflows/ci.yml` (na branch `feat/bills-recurrence`).
- Memória persistente da sessão Claude para este diretório: `~/.claude/projects/-mnt-Dados-projects-finance/memory/` (índice `MEMORY.md`), com os mesmos fatos deste arquivo em forma curta.

## 8. Perguntas em aberto para o usuário

- Aprovar dependências de teste de componente no client (`@testing-library/react` já existe via jsdom? verificar `client/package.json` em `origin/master`; `jsdom` foi adicionado no PR 2).
- Confirmar se o canal de consulta aos portais da SEFAZ (Playwright) deve ficar atrás de configuração desligada por padrão (ressalva R2 da revisão).
- Decidir o destino da classificação item a item na conciliação do Módulo 3 (ressalva R3).
