# HANDOFF — estado do projeto Finance e como continuar

Atualizado em 2026-11-12 (sessão com Claude Fable 5.1; PR2, PR3, a publicação dos PRs e o PR4 na sessão com Claude Opus 5.5). Leia este arquivo antes de qualquer trabalho; ele resume o que já foi decidido, feito e o que falta, com ponteiros para os documentos detalhados. Os documentos de referência estão em `docs/`:

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

## 2. Estado das branches (2026-11-12)

As branches do Módulo 1 estão **empilhadas sobre o PR #5** (Módulo 3) e publicadas como PRs empilhados no GitHub: a base de cada PR é a branch anterior. Ordem de merge: **#5 → PR1 → PR2 → PR3 → PR4**. Ao mesclar um PR, apagar a branch dele faz o GitHub trocar a base do seguinte para `master`; se a branch não for apagada, troque a base manualmente.

| Branch | Onde | Estado |
|---|---|---|
| `origin/master` (7676fe5) | remoto | PR 2 (importação com decisões de categoria), PR 3 (lembretes por e-mail, migração `0006_slimy_nekra`), PR 4 (OpenCode simplificado) |
| `feat/module3-purchases` (5c03ee6) | **PR #5** | Módulo 3 (compras/NFC-e), migrações `0007`–`0014`, 418 + 53 testes. Revisado e aprovado com ressalvas (`docs/revisao-modulo-3-2026-11.md`). **Decisão de merge é do usuário** |
| `feat/bills-recurrence` | PR1 (base: `feat/module3-purchases`) | CI, imagens movidas, análise, plano, modelo de recorrência/ocorrência/pagamento com migração **`0015_bill_templates_and_payments`**, revisão do M3, este HANDOFF. 465 + 53 testes |
| `feat/bills-payments` | PR2 (base: `feat/bills-recurrence`) | Pagar com lançamento ou vínculo, guards no Módulo 2. 482 + 53 testes |
| `feat/bills-api` | PR3 (base: `feat/bills-payments`) | Rotas Zod de ocorrências e recorrências, multipart compartilhado, cliente tipado. 494 + 53 testes |
| `feat/bills-ui` | PR4 em andamento (base: `feat/bills-api`) | Tela nova de contas a pagar e remoção do legado |
| `feat/bills-recurrence-oldbase`, `feat/import-installments-category-matching` | local | Bases antigas, sem uso. Podem ser apagadas |

O usuário autorizou (2026-11-12) **publicar cada PR assim que concluído** (push da branch e abertura do PR); merge continua sendo decisão dele.

O usuário trabalha em mais de uma máquina (Windows e Linux) e com sessões paralelas de IA que fazem merge no remoto. **Sempre `git fetch origin` e criar branches a partir de `origin/master`.**

## 3. Decisões tomadas com o usuário (não reabrir sem motivo)

- **Módulo 1 é agenda de pagamentos**; a conciliação com o Módulo 2 é opcional e frouxa. "Pagar" tem três modos: `external` (só marca paga; padrão do popover), `transaction` (cria lançamento; padrão quando o template tem conta padrão) e `link` (vincula lançamento existente; usado pelo auto-match da importação).
- **Recorrência** termina por data (`endDate`) **ou** por quantidade (`occurrenceCount`); vale o que acabar primeiro. Conta avulsa nunca gera ocorrência futura. 12 meses é só o horizonte de materialização.
- **Status derivado, nunca gravado**: só `open | paid | skipped` no banco; atrasada/hoje/agendada/futura vêm de `state` + datas.
- **Manter a tabela `scheduled_bills`** como ocorrência (sem renomear). "AG" virou `scheduled_for`.
- **Excluir lançamento vinculado a pagamento é bloqueado** (mesmo padrão das transferências), não cascateado.
- **Sugestões nunca se aplicam sozinhas** (categorias, transferências, pagamentos de contas): decisão explícita na prévia.
- **Ordem de merge**: PR #5 (Módulo 3) entra primeiro; os PRs do Módulo 1 já estão empilhados sobre ele, com a migração renumerada para `0015`.
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

Schema/migração: `bill_templates`, `bill_payments`, `scheduled_bills` recriada (sem `status`; com `template_id`, `sequence`, `state`, `scheduled_for`, `paid_at`, `paid_cents`, `payment_method_id`, `notes`, `migrated_payment`). Migração `0015_bill_templates_and_payments.sql` copia `''/AG/PG → open/open+scheduled_for/paid+migrated_payment=1`. Lembretes por e-mail (`bill-reminders.ts`) passaram a filtrar `state = 'open' AND scheduled_for IS NULL`. Reset de dados inclui `bill_payments`, `scheduled_bills`, `bill_templates` (antes `db:reset:all` falhava por FK).

Testes novos: `bills-recurrence`, `bills-templates`, `bills-occurrences`, `bills-migration` (aplica migrações até `0014`, semeia dados legados e lembretes, aplica `0015`, confere). Os testes antigos de status/repeat continuam válidos pela camada legada.

## 5. O que falta (em ordem)

1. ~~**Empilhar sobre o Módulo 3**~~ — **feito** (2026-11-12): pilha rebaseada sobre o PR #5 com `git rebase --onto origin/feat/module3-purchases origin/master --update-refs`; migração regenerada como `0015` com o procedimento da seção 6 (SQL idêntico à antiga `0007`); resets unidos. Falta só o usuário decidir o merge do #5.
2. ~~**PR2**~~ — **feito** em `feat/bills-payments` (ver registro no plano).
3. ~~**PR3**~~ — **feito** em `feat/bills-api` (ver registro no plano). `/status` e `/repeat` ficaram como deprecated e saem no PR4.
4. **PR4** — tela nova (filas atrasadas/hoje/7 dias/mês, chip de status, popover "Pagar" com toggle "Registrar lançamento", formulário com toggle "Repetir" e prévia de 6 datas, "só esta / esta e as futuras", URL persistente, badge no menu). Remover `legacy.ts`, `status` e `counts` legados, testes antigos de status/repeat (com justificativa no commit).
5. **PR5** — auto-match de pagamentos na importação de extrato (`bill-payment-detection.ts`, `billCandidates`/`billDecisions`).
6. **PR6** — docs finais.
7. **Módulo 3, após o merge**: ressalvas R3 (conciliar sobrescreve categoria dos itens), R4 (`purchases.transaction_id` redundante), R6 (tsconfig `lib: DOM`, teste do parser RJ, mensagens em BRL), R7 (código do item e `purchase_payments` para o Módulo 4).
8. **Módulo 2** (fase 2 da análise): entidade conta evoluindo `payment_methods.balance_type`, perfis de arquivo por banco, OFX, grupo de parcelas, rateio/tags, regras, desfazer lote, quebrar `import.ts`/`TransactionsImportPage.tsx` em wizard.

## 6. Armadilhas aprendidas (evite repetir)

- **Migrator do Drizzle roda em transação**: `PRAGMA foreign_keys=OFF` gerado pelo drizzle-kit **não tem efeito**. Um rebuild de tabela (`__new_x` + `DROP` + `RENAME`) dispara `ON DELETE SET NULL/CASCADE` nos filhos e na auto-referência. Solução usada na `0015`: copiar filhos/colunas auto-referentes para tabelas auxiliares antes do `DROP` e restaurar após o `RENAME`. Teste de migração cobre isso.
- **`drizzle-kit generate` é interativo** quando há coluna removida + colunas adicionadas na mesma tabela (pergunta "rename ou nova?") e falha sem TTY. Contorno: gerar em dois passos (manter a coluna antiga, gerar; editar o SQL à mão para remover a coluna e fazer a cópia de dados; apagar a coluna do snapshot JSON; remover do `schema.ts`; `generate` deve responder "No schema changes").
- **O INSERT…SELECT gerado para rebuild seleciona colunas novas da tabela antiga** (não existem): sempre revisar e reescrever o SELECT com `CASE`/`NULL`.
- **`better-sqlite3` precisa de `npm rebuild better-sqlite3`** quando o `node_modules` veio de outro SO/Node ("Could not locate the bindings file").
- **`npx vitest run … -w`**: `-w` é **watch**, não workspace; trava o comando. Rode dentro de `server/` ou `client/`.
- **`git commit` commita tudo que está no índice**: após `git checkout <branch> -- arquivos`, os arquivos ficam staged; faça `git reset` antes de commits por unidade.
- A tela atual de contas e os lembretes dependem do campo legado `status`/`counts` do DTO até o PR4.
- O `.gitattributes` do `origin/master` já define `* text=auto eol=lf`; não renormalizar retroativamente (decisão registrada lá).

## 7. Ambiente e comandos

- Node 24, npm workspaces. `npm install` → `npm run build` → `npm test` (gate). `npm run db:backup` antes de qualquer migração. `npm run dev` sobe API em 3001 e web em 5173.
- Baseline de testes (já incluindo os do Módulo 3): PR #5 418 + 53; PR1 465 + 53 (518); PR2 482 + 53 (535); PR3 494 + 53 (547).
- CI em `.github/workflows/ci.yml` (na branch `feat/bills-recurrence`).
- Memória persistente da sessão Claude para este diretório: `~/.claude/projects/-mnt-Dados-projects-finance/memory/` (índice `MEMORY.md`), com os mesmos fatos deste arquivo em forma curta.

## 8. Perguntas em aberto para o usuário

- ~~Dependências de teste de componente~~: não são necessárias; os testes de página usam `react-dom/client` + `act` + jsdom, que já existem.
- Confirmar se o canal de consulta aos portais da SEFAZ (Playwright) deve ficar atrás de configuração desligada por padrão (ressalva R2 da revisão).
- Decidir o destino da classificação item a item na conciliação do Módulo 3 (ressalva R3).
