# HANDOFF — estado do projeto Finance e como continuar

Atualizado em 2026-11-12 (sessão com Claude Fable 5.1; PR2 a PR6, publicação e merges na sessão com Claude Opus 5.5). **O plano do Módulo 1 e as ressalvas do Módulo 3 estão concluídos**; o backlog oficial está na seção 5 (atualizado em 2026-11-16). Leia este arquivo antes de qualquer trabalho; ele resume o que já foi decidido, feito e o que falta, com ponteiros para os documentos detalhados. Os documentos de referência estão em `docs/`:

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
| #13 | `fix/purchase-reconcile-item-categories` | R3: conciliação só categoriza itens sem categoria | `1040b49` |
| #14, #15 | `chore/nfce-portal-query-opt-in`, `chore/drop-purchases-transaction-id` | R2 e R4; mesclados nas bases empilhadas, não no `master` | `381e3a5`, `4332e07` |

O #16 levou ao `master` a R2 e a R4, e o #17 (R6) foi mesclado em seguida (`cabbf68`).

**Fluxo de branches (desde 2026-11-16):** a `develop` nasceu de `cabbf68` e concentra os PRs; o `master` só a recebe por PR de release, aberto ao concluir um módulo. Branches novas saem da `develop` e são apagadas depois do merge. No remoto ficam só `master`, `develop` e as branches de PRs abertos. As antigas `feat/bills-recurrence-oldbase` e `feat/import-installments-category-matching` (versões pré-rebase do Módulo 1, já substituídas) viraram tags locais `archive/…`.

O CI (`.github/workflows/ci.yml`, build + testes em Linux) roda em todo push no `master` e na `develop` e em PRs. Ele só passou a valer depois de chegar ao `master`; trocar a base de um PR não o dispara, só um push. O Codex revisa cada PR automaticamente e, nos PRs deste trabalho, sempre encontrou algo real: espere a revisão terminar antes de mesclar, ou trate o apontamento em PR de acompanhamento.

O usuário autorizou (2026-11-12) **publicar cada PR assim que concluído** (push da branch e abertura do PR); merge continua sendo decisão dele.

**Release (regra do usuário, 2026-11-16):** quando um módulo for concluído, abra um PR de release da `develop` para o `master` (o primeiro, ao terminar o Módulo 1). O merge da release continua sendo decisão do usuário.

**GitHub (2026-11-16):** a branch padrão do repositório é a `develop`, e as branches de PR mescladas são apagadas automaticamente pelo GitHub.

**Dados:** o banco local (`server/data/finance.db`) só tem dados de teste; nada é de produção ainda. O backup antes de migração continua sendo regra do `AGENTS.md`.

O usuário trabalha em mais de uma máquina (Windows e Linux) e com sessões paralelas de IA que fazem merge no remoto. **Sempre `git fetch origin` e criar branches a partir de `origin/develop`**, que concentra os PRs; o `master` só recebe releases.

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

## 5. Backlog oficial (registrado em 2026-11-16)

Estado: Módulo 1 com o plano concluído e pagamento parcial entregue (#20); Módulo 3 com as ressalvas R2–R7 resolvidas; Módulo 2 na fase 1; Módulo 4 não iniciado. Itens riscados ficam como histórico; ao concluir um item, risque-o aqui no mesmo PR.

### Módulo 1 — Contas a pagar
- ~~Pagamento parcial na tela~~ (#20, migração `0018`).
- Notificações locais (navegador/celular) com antecedência configurável; hoje só há o contador no menu e o e-mail. Depende da PWA.
- ~~Anexos (boleto em PDF) e linha digitável~~ (migração `0021`: `scheduled_bills.barcode` e `bill_attachments` com o arquivo no banco; diálogo "Boleto e anexos"; `lib/barcode.ts` confere os DVs e lê valor e vencimento).
- ~~Ler a linha digitável do PDF anexado~~ (`findBarcodeInText` + `lib/pdf-text.ts`, compartilhado com a NFC-e; só PDFs com texto).
- ~~Visão em calendário do mês~~ (alternância Lista/Calendário na tela de contas, `layout=calendar` na URL; o dia escolhido mostra as contas dele com as ações da lista).
- ~~Previsão dos próximos meses na tela~~ (cartões "Próximos meses" na tela de contas, usando `GET /api/bills/forecast`).
- ~~Ações em massa (marcar várias como pagas ou puladas) e atalhos de teclado (N nova conta, P pagar)~~ (seleção na lista do mês, `POST /api/bills/bulk-pay` e `/bulk-skip`, tudo ou nada; pagar em massa é sempre externo, sem lançamento).
- Sugerir recorrências pelo histórico de lançamentos ("find schedules"); depende das regras do Módulo 2.
- ~~Criar a conta a partir do boleto anexado~~ ("Preencher pelo boleto" em Nova conta; `services/bills/boleto-reader.ts`: linha digitável, beneficiário e sugestão pelo histórico — mesma empresa no código de barras ou beneficiário parecido).
- ~~Gráfico pago × previsto por mês~~ (tela de contas, `ColumnChart`; `GET /api/bills/forecast?past=N` traz os meses anteriores). Falta: contas por categoria no mês e atrasos por mês.
- ~~Recorrência na importação de contas por planilha~~ (coluna **Repetição**: `mensal`, `trimestral 4x`, `mensal, último dia útil`…; importação atômica).
- ~~Tela para a importação de contas por planilha~~ (`/importacoes/contas`, com cartão no hub e botão em Contas a pagar; a prévia marca as duplicadas por linha).
- ~~M1-06: cálculo de duplicidade repetido em `bills-import.ts` (prévia e importação)~~ (`duplicateRowNumbers` compartilhado).
- ~~Recorrência no "último dia útil" do mês~~ (migração `0019`, coluna `bill_templates.last_business_day`; `lib/business-days.ts` com feriados bancários nacionais e Páscoa).
- ~~Um lançamento pagando várias contas (boleto agrupado)~~ (migração `0020`: único passa a ser `bill_id + transaction_id`; `POST /api/bills/group-pay` e opção no pagamento em massa; desfazer uma conta desfaz o grupo).
- ~~Sugerir na importação de extrato um boleto agrupado~~ (`groupBills` no candidato; 2 a 4 contas, sempre "possível"; confirmar usa `payBillsWithOneTransaction` com `origin: import_match`).
- ~~Sobras do pagamento parcial: desfazer um pagamento de cada vez; sugerir na importação o restante de uma conta com parcial~~ (`DELETE /api/bills/:id/payments/:paymentId` e diálogo "Pagamentos da conta"; a detecção compara a conta com parcial pelo valor exato que falta).

### Módulo 2 — Movimentações e importação (fase 2)
- Entidade conta (corrente, cartão, benefício, dinheiro) evoluindo `payment_methods.balance_type`, com saldo por conta e fatura de cartão (M2-01, M2-09).
- Perfis de arquivo por banco: Nubank, Itaú, Inter, C6, BB, Caixa, Mercado Pago (M2-02).
- Importação de OFX (M2-03; parser próprio ou dependência a aprovar).
- Grupo de parcelas de uma compra (M2-04).
- Rateio entre categorias e tags (M2-05).
- Regras automáticas "condição → ação" (M2-06).
- Desfazer lote de importação (M2-07).
- Quebrar `services/import.ts` em módulos e `TransactionsImportPage.tsx` (3 mil linhas) em assistente por etapas (M2-08).
- Listagem: gráfico de tendência mensal e orçamento por categoria no consolidado.
- Gráficos (sugestões de 2026-11-17):
  - ~~Entradas, saídas e saldo por mês~~ (Consolidado, `MonthlyFlowChart`; falta: clicar no mês abrir a listagem).
  - ~~Despesas por categoria no período~~ (Consolidado, `CategoryBars`, segue a aba despesas/receitas/transferências; falta: marca de comparação com o período anterior) e evolução das 5 maiores categorias (linhas).
  - Saldo acumulado por conta (linha por conta; depende da entidade conta, M2-01).
  - Parcelas já comprometidas nos próximos meses (barras empilhadas por cartão/conta; usa as parcelas futuras gravadas).
  - Maiores estabelecimentos/descrições do período (barras horizontais, top 10).
  - Calendário de calor dos gastos por dia do mês (identifica picos de fatura e de débito automático).

### Módulo 3 — Compras/NFC-e
- ~~Ressalvas R2–R7 da revisão~~ (#13–#18).
- Fornecedores e filiais em tabelas próprias (hoje o fornecedor fica em cada compra).
- Prévia editável: corrigir itens antes de gravar.
- Novos canais: JSON, foto da nota com OCR, leitura do QR Code pela câmera.
- Conciliação automática pelas formas de pagamento da nota (`purchase_payments`) e tela própria de conciliação (conciliada / parcial / sem movimento / sem compra).
- Parcelas no cartão na conciliação (depende do grupo de parcelas do Módulo 2).
- Dinheiro, cashback e bônus: escolher se geram movimento.
- Parser do RJ lê só duas casas do preço unitário (`6,6667` vira R$ 6,66); o total do item não é afetado.
- Gráficos (sugestões de 2026-11-17):
  - ~~Gasto em compras por mês, empilhado por fornecedor~~ (lista de compras, 12 meses até o mês escolhido, 5 maiores pelo CNPJ e "Outros").
  - Ticket médio e número de compras por mês (barras com linha).
  - Gasto por categoria de item no período (barras horizontais) e a variação contra o período anterior.
  - Formas de pagamento das notas por mês (barras empilhadas; usa `purchase_payments`).
  - Conciliação: notas conciliadas, parciais e sem movimento por mês (depende da tela de conciliação).

### Módulo 4 — Produtos (não iniciado)
- Normalização de produtos (mesmo produto com descrições diferentes, como "coca-cola 1,5l" e "2,5l").
- Preço por unidade de medida.
- Histórico de preço por produto e por fornecedor.
- Base já gravada: descrição, quantidade, unidade, `code` e `ean` dos itens (R7).
- Sugestões de 2026-11-17:
  - Catálogo de produtos: tabela `products` (nome normalizado, marca, embalagem, unidade base) e vínculo dos itens de compra; casar primeiro pelo EAN, depois pelo código do fornecedor e por fim pela descrição normalizada, com revisão das sugestões (mesmo padrão de confirmação da importação).
  - Extrair embalagem e quantidade da descrição ("1,5L", "500g", "c/12") para calcular o preço por litro/kg/unidade e comparar tamanhos diferentes do mesmo produto.
  - Variantes e equivalentes: agrupar marca e tamanho sob um produto genérico ("refrigerante cola") para comparar marcas.
  - Alerta de preço: item comprado acima da média dos últimos N preços do produto, mostrado na prévia da NFC-e.
  - Melhor lugar para comprar: menor preço recente por fornecedor para os produtos mais comprados.
  - Frequência de compra e previsão de reposição (intervalo médio entre compras) e lista de compras sugerida.
  - Inflação pessoal: índice da cesta dos produtos comprados com regularidade, mês contra mês.
  - Gráficos: evolução de preço por produto (linha por fornecedor), preço por unidade entre tamanhos e marcas (barras), dispersão preço × data com a média móvel e o índice da cesta por mês (linha).

### Transversal
- ESLint e Prettier no gate de qualidade.
- `packages/domain` e `api-client` (análise, seção 5), base para o mobile.
- PWA; depois app com Expo.
- Teste de ponta a ponta de um fluxo de importação.
- README com comandos de Linux/macOS (hoje quase todos estão como `npm.cmd`).

## 6. Armadilhas aprendidas (evite repetir)

- **Migrator do Drizzle roda em transação**: `PRAGMA foreign_keys=OFF` gerado pelo drizzle-kit **não tem efeito**. Um rebuild de tabela (`__new_x` + `DROP` + `RENAME`) dispara `ON DELETE SET NULL/CASCADE` nos filhos e na auto-referência. Solução usada na `0015` e na `0016`: copiar filhos/colunas auto-referentes para tabelas auxiliares antes do `DROP` e restaurar após o `RENAME`; filhos com `ON DELETE RESTRICT` (como `payment_balance_adjustments.purchase_id`) precisam ser apagados antes do `DROP` e reinseridos depois. Testes de migração cobrem isso. Desde a `0021`, `scheduled_bills` tem como filhos também `bill_attachments` (com o arquivo do anexo, `ON DELETE CASCADE`): um rebuild de `scheduled_bills` precisa preservá-los da mesma forma.
- **`drizzle-kit generate` é interativo** quando há coluna removida + colunas adicionadas na mesma tabela (pergunta "rename ou nova?") e falha sem TTY. Contorno: gerar em dois passos (manter a coluna antiga, gerar; editar o SQL à mão para remover a coluna e fazer a cópia de dados; apagar a coluna do snapshot JSON; remover do `schema.ts`; `generate` deve responder "No schema changes").
- **O INSERT…SELECT gerado para rebuild seleciona colunas novas da tabela antiga** (não existem): sempre revisar e reescrever o SELECT com `CASE`/`NULL`.
- **`better-sqlite3` precisa de `npm rebuild better-sqlite3`** quando o `node_modules` veio de outro SO/Node ("Could not locate the bindings file").
- **`npx vitest run … -w`**: `-w` é **watch**, não workspace; trava o comando. Rode dentro de `server/` ou `client/`.
- **`git commit` commita tudo que está no índice**: após `git checkout <branch> -- arquivos`, os arquivos ficam staged; faça `git reset` antes de commits por unidade.
- A tela atual de contas e os lembretes dependem do campo legado `status`/`counts` do DTO até o PR4.
- **PRs empilhados**: abra todos contra a `develop`, mesmo empilhados. Se um PR tiver como base outra branch de PR, troque a base para `develop` (`gh pr edit N --base develop`) antes de mesclá-lo. O #14 e o #15 foram mesclados nas bases antigas e não chegaram ao `master`; o #16 corrigiu isso.
- O `.gitattributes` do `origin/master` já define `* text=auto eol=lf`; não renormalizar retroativamente (decisão registrada lá).

- **`@fastify/static` com `wildcard: false`** registra a lista de arquivos ao iniciar: depois de um `vite build`, o servidor de produção precisa ser reiniciado, senão o bundle novo responde `index.html` (tela branca, erro de MIME no console).
- **Verificar a tela no navegador sem tocar no banco real**: copie o backup mais recente para o scratchpad e suba `node server/dist/index.js` com `DATABASE_PATH` apontando para a cópia e `PORT` livre (nesta máquina 3101 e 5173 já estão ocupadas por outros apps). Os lembretes ficam desligados sem `.env`; deixe `BILL_REMINDER_TO=` vazio por garantia.

## 7. Ambiente e comandos

- Node 24, npm workspaces. `npm install` → `npm run build` → `npm test` (gate). `npm run db:backup` antes de qualquer migração. `npm run dev` sobe API em 3001 e web em 5173.
- Baseline de testes (já incluindo os do Módulo 3): PR #5 418 + 53; PR1 465 + 53 (518); PR2 482 + 53 (535); PR3 494 + 53 (547); PR4 489 + 73 (562); PR4 após trazer o `master` (com a correção do review do #6) e a do próprio review: 496 + 78 (574). O PR1 ganhou +5 testes com a correção do review (470 + 53). PR5: 511 + 83 (594); #11: 511 + 84 (595); R3 do Módulo 3: 512 + 84 (596); R2 do Módulo 3: 515 + 85 (600); R4 do Módulo 3: 516 + 85 (601); R6 do Módulo 3: 520 + 85 (605); R7 do Módulo 3: 528 + 86 (614); pagamento parcial: 538 + 89 (627); previsão na tela: 538 + 91 (629); ações em massa: 542 + 96 (638); calendário: 542 + 99 (641); sobras do parcial: 548 + 101 (649); último dia útil: 555 + 102 (657); repetição na planilha: 558 + 102 (660); tela da planilha: 558 + 105 (663); boleto agrupado: 563 + 107 (670); anexos e linha digitável: 574 + 110 (684); linha do PDF: 578 + 111 (689); agrupado na importação: 580 + 113 (693); conta pelo boleto: 585 + 117 (702); gráficos do consolidado: 585 + 124 (709); gráficos de contas e compras: 585 + 128 (713).
- CI em `.github/workflows/ci.yml` (na branch `feat/bills-recurrence`).
- Memória persistente da sessão Claude para este diretório: `~/.claude/projects/-mnt-Dados-projects-finance/memory/` (índice `MEMORY.md`), com os mesmos fatos deste arquivo em forma curta.

## 8. Perguntas em aberto para o usuário

- ~~Dependências de teste de componente~~: não são necessárias; os testes de página usam `react-dom/client` + `act` + jsdom, que já existem.
- ~~Canal de consulta aos portais da SEFAZ (R2)~~: decidido em 2026-11-12; fica desligado por padrão, atrás de `NFCE_PORTAL_QUERY_ENABLED=true`.
- ~~Classificação item a item na conciliação (R3)~~: decidido em 2026-11-12; só itens sem categoria ou em "Sem categoria" recebem a categoria da compra.
- ~~Pré-confirmação na importação~~: decidido em 2026-11-12; os pares de alta confiança e sem disputa com contas a pagar continuam vindo pré-confirmados.
- ~~Prioridade~~: em 2026-11-12 o usuário escolheu começar pelas ressalvas do Módulo 3 e confirmou as sobras do Módulo 1 e a fase 2 do Módulo 2 como próximas frentes.
