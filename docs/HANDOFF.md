# HANDOFF — estado do projeto Finance e como continuar

Atualizado em 2026-11-12 (sessão com Claude Fable 5.1; PR2 a PR6, publicação e merges na sessão com Claude Opus 5.5). **O Módulo 1 do plano está concluído**; os próximos trabalhos estão na seção 5. Leia este arquivo antes de qualquer trabalho; ele resume o que já foi decidido, feito e o que falta, com ponteiros para os documentos detalhados. Os documentos de referência estão em `docs/`:

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

## 2. Estado do repositório (2026-11-12)

Tudo o que foi feito está em `master`. Merges de 2026-11-12, em ordem:

| PR | Branch | Conteúdo | Merge |
|---|---|---|---|
| #5 | `feat/module3-purchases` | Módulo 3 (compras/NFC-e), migrações `0007`–`0014` | `7acb54f` |
| #6 | `feat/bills-recurrence` | CI, docs, modelo de recorrência/ocorrência/pagamento, migração `0015_bill_templates_and_payments` | `c012364` |
| #7 | `feat/bills-payments` | Pagar criando ou vinculando lançamento; guards no Módulo 2 | `82614de` |
| #8 | `feat/bills-api` | Rotas Zod, multipart compartilhado, cliente tipado | `9805aff` |
| #9 | `feat/bills-ui` | Tela nova de contas a pagar e remoção do legado | `854c42a` |
| #10 | `feat/bills-import-match` | Sugestão e vínculo de pagamentos de contas na importação | `386cc25` |
| #11 | `fix/import-bill-candidates-all` | Abas de contas e de transferências da importação mostram todos os pares | `d8f9b21` |
| #12 | `chore/bills-docs-final` | Documentação final do Módulo 1 | `2f883ee` |

Em andamento: `fix/purchase-reconcile-item-categories` (#13, ressalva R3 do Módulo 3), `chore/nfce-portal-query-opt-in` (#14, ressalva R2, empilhada sobre o #13) e `chore/drop-purchases-transaction-id` (ressalva R4 com a migração `0016`, empilhada sobre o #14). As branches mescladas não foram apagadas; `feat/bills-recurrence-oldbase` e `feat/import-installments-category-matching` são locais e sem uso.

O CI (`.github/workflows/ci.yml`, build + testes em Linux) roda em todo push no `master` e em PRs. Ele só passou a valer depois de chegar ao `master`; trocar a base de um PR não o dispara, só um push. O Codex revisa cada PR automaticamente e, nos PRs deste trabalho, sempre encontrou algo real: espere a revisão terminar antes de mesclar, ou trate o apontamento em PR de acompanhamento.

O usuário autorizou (2026-11-12) **publicar cada PR assim que concluído** (push da branch e abertura do PR); merge continua sendo decisão dele.

O usuário trabalha em mais de uma máquina (Windows e Linux) e com sessões paralelas de IA que fazem merge no remoto. **Sempre `git fetch origin` e criar branches a partir de `origin/master`.**

## 3. Decisões tomadas com o usuário (não reabrir sem motivo)

- **Módulo 1 é agenda de pagamentos**; a conciliação com o Módulo 2 é opcional e frouxa. "Pagar" tem três modos: `external` (só marca paga; padrão do popover), `transaction` (cria lançamento; padrão quando o template tem conta padrão) e `link` (vincula lançamento existente; usado pelo auto-match da importação).
- **Recorrência** termina por data (`endDate`) **ou** por quantidade (`occurrenceCount`); vale o que acabar primeiro. Conta avulsa nunca gera ocorrência futura. 12 meses é só o horizonte de materialização.
- **Status derivado, nunca gravado**: só `open | paid | skipped` no banco; atrasada/hoje/agendada/futura vêm de `state` + datas.
- **Manter a tabela `scheduled_bills`** como ocorrência (sem renomear). "AG" virou `scheduled_for`.
- **Excluir lançamento vinculado a pagamento é bloqueado** (mesmo padrão das transferências), não cascateado.
- **Sugestões nunca se aplicam sozinhas** (categorias, transferências, pagamentos de contas): decisão explícita na prévia.
- **Ordem de merge** (cumprida): PR #5 (Módulo 3) primeiro, depois os PRs do Módulo 1 empilhados sobre ele, com a migração renumerada para `0015`.
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

## 5. O que falta (em ordem sugerida)

O plano do Módulo 1 (`docs/plano-modulo-1-contas-a-pagar.md`) está concluído: PR1–PR6 mesclados (#6 a #12). O registro de cada PR está na seção 9 do plano.

1. **Módulo 3 — ressalvas da revisão** (`docs/revisao-modulo-3-2026-11.md`): R3 resolvida (a conciliação só categoriza itens sem categoria ou em "Sem categoria"); R2 resolvida (consulta aos portais atrás de `NFCE_PORTAL_QUERY_ENABLED`, desligada por padrão); R4 resolvida (migração `0016` remove `purchases.transaction_id`); faltam R6 (tsconfig `lib: DOM` no server inteiro, teste próprio do parser RJ, mensagens de saldo em BRL) e R7 (código do item e formas de pagamento da nota em linhas, para o Módulo 4).
2. **Módulo 1 — sobras fora de escopo** (plano, seção 8): pagamento parcial na tela, notificações locais/PWA, anexos e linha digitável, visão calendário, "find schedules" (sugerir recorrências pelo histórico), recorrência na importação de contas por planilha, M1-06 (duplicidade duplicada em `bills-import.ts`), ações em massa e atalhos.
3. **Módulo 2** (fase 2 da análise): entidade conta evoluindo `payment_methods.balance_type`, perfis de arquivo por banco, OFX, grupo de parcelas, rateio/tags, regras, desfazer lote, quebrar `import.ts`/`TransactionsImportPage.tsx` (3 mil linhas) em wizard.
4. **Transversal**: ESLint/Prettier, `packages/domain` e `api-client` (análise, seção 5), PWA.

## 6. Armadilhas aprendidas (evite repetir)

- **Migrator do Drizzle roda em transação**: `PRAGMA foreign_keys=OFF` gerado pelo drizzle-kit **não tem efeito**. Um rebuild de tabela (`__new_x` + `DROP` + `RENAME`) dispara `ON DELETE SET NULL/CASCADE` nos filhos e na auto-referência. Solução usada na `0015` e na `0016`: copiar filhos/colunas auto-referentes para tabelas auxiliares antes do `DROP` e restaurar após o `RENAME`; filhos com `ON DELETE RESTRICT` (como `payment_balance_adjustments.purchase_id`) precisam ser apagados antes do `DROP` e reinseridos depois. Testes de migração cobrem isso.
- **`drizzle-kit generate` é interativo** quando há coluna removida + colunas adicionadas na mesma tabela (pergunta "rename ou nova?") e falha sem TTY. Contorno: gerar em dois passos (manter a coluna antiga, gerar; editar o SQL à mão para remover a coluna e fazer a cópia de dados; apagar a coluna do snapshot JSON; remover do `schema.ts`; `generate` deve responder "No schema changes").
- **O INSERT…SELECT gerado para rebuild seleciona colunas novas da tabela antiga** (não existem): sempre revisar e reescrever o SELECT com `CASE`/`NULL`.
- **`better-sqlite3` precisa de `npm rebuild better-sqlite3`** quando o `node_modules` veio de outro SO/Node ("Could not locate the bindings file").
- **`npx vitest run … -w`**: `-w` é **watch**, não workspace; trava o comando. Rode dentro de `server/` ou `client/`.
- **`git commit` commita tudo que está no índice**: após `git checkout <branch> -- arquivos`, os arquivos ficam staged; faça `git reset` antes de commits por unidade.
- A tela atual de contas e os lembretes dependem do campo legado `status`/`counts` do DTO até o PR4.
- O `.gitattributes` do `origin/master` já define `* text=auto eol=lf`; não renormalizar retroativamente (decisão registrada lá).

- **`@fastify/static` com `wildcard: false`** registra a lista de arquivos ao iniciar: depois de um `vite build`, o servidor de produção precisa ser reiniciado, senão o bundle novo responde `index.html` (tela branca, erro de MIME no console).
- **Verificar a tela no navegador sem tocar no banco real**: copie o backup mais recente para o scratchpad e suba `node server/dist/index.js` com `DATABASE_PATH` apontando para a cópia e `PORT` livre (nesta máquina 3101 e 5173 já estão ocupadas por outros apps). Os lembretes ficam desligados sem `.env`; deixe `BILL_REMINDER_TO=` vazio por garantia.

## 7. Ambiente e comandos

- Node 24, npm workspaces. `npm install` → `npm run build` → `npm test` (gate). `npm run db:backup` antes de qualquer migração. `npm run dev` sobe API em 3001 e web em 5173.
- Baseline de testes (já incluindo os do Módulo 3): PR #5 418 + 53; PR1 465 + 53 (518); PR2 482 + 53 (535); PR3 494 + 53 (547); PR4 489 + 73 (562); PR4 após trazer o `master` (com a correção do review do #6) e a do próprio review: 496 + 78 (574). O PR1 ganhou +5 testes com a correção do review (470 + 53). PR5: 511 + 83 (594); #11: 511 + 84 (595); R3 do Módulo 3: 512 + 84 (596); R2 do Módulo 3: 515 + 85 (600); R4 do Módulo 3: 516 + 85 (601).
- CI em `.github/workflows/ci.yml` (na branch `feat/bills-recurrence`).
- Memória persistente da sessão Claude para este diretório: `~/.claude/projects/-mnt-Dados-projects-finance/memory/` (índice `MEMORY.md`), com os mesmos fatos deste arquivo em forma curta.

## 8. Perguntas em aberto para o usuário

- ~~Dependências de teste de componente~~: não são necessárias; os testes de página usam `react-dom/client` + `act` + jsdom, que já existem.
- ~~Canal de consulta aos portais da SEFAZ (R2)~~: decidido em 2026-11-12; fica desligado por padrão, atrás de `NFCE_PORTAL_QUERY_ENABLED=true`.
- ~~Classificação item a item na conciliação (R3)~~: decidido em 2026-11-12; só itens sem categoria ou em "Sem categoria" recebem a categoria da compra.
- ~~Pré-confirmação na importação~~: decidido em 2026-11-12; os pares de alta confiança e sem disputa com contas a pagar continuam vindo pré-confirmados.
- ~~Prioridade~~: em 2026-11-12 o usuário escolheu começar pelas ressalvas do Módulo 3 e confirmou as sobras do Módulo 1 e a fase 2 do Módulo 2 como próximas frentes.
