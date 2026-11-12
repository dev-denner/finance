# Finance — análise do estado atual e propostas de evolução

Data: 2026-11-11 · Branch analisada: `feat/import-installments-category-matching`

Este documento é o levantamento da fase 1 (somente análise). Não houve alteração de código, exceto a recompilação local do módulo nativo `better-sqlite3` para rodar a suíte de testes.

---

## 1. Estado do repositório

### 1.1 O que existe

| Área | Situação | Evidência |
|---|---|---|
| Módulo 1 · Contas a pagar | Funcional, CRUD + status + "repetir no mês seguinte" + importação CSV/Excel própria | `server/src/services/bills.ts`, `bills-import.ts`, `client/src/pages/BillsPage.tsx` |
| Módulo 2 · Movimentos | O mais maduro: importação com prévia, mapeamento, modelos de mapeamento, duplicidades, parcelas, transferências, sugestão de categoria com aliases, consolidado anual, fluxo por conta | `server/src/services/import.ts` (1.783 linhas), `transactions.ts`, `transfer-detection.ts`, `category-matching.ts`, `consolidation.ts` |
| Módulo 3 · Compras / NFC-e | **Não existe código.** Nenhuma referência a NFC-e, QR code, fornecedor ou item de compra no repositório | `grep` em `client/src` e `server/src` |
| Módulo 4 · Produtos | Não iniciado (previsto) | — |

Stack: TypeScript strict, Fastify 5, React 19 + Vite 7, Tailwind 3, SQLite (`better-sqlite3`) + Drizzle, Vitest. Seis migrações versionadas, triggers de integridade em `transfers`, dinheiro em centavos inteiros, datas ISO.

### 1.2 Qualidade e baseline

- `npm run build`: verde (server e client).
- `npm test`: **195 testes no server + 7 no client**, todos verdes **após** `npm rebuild better-sqlite3`. O `node_modules` foi instalado em outro ambiente (README é todo em `npm.cmd`/PowerShell) e o binário nativo Linux não existia; sem o rebuild 151 testes falham com "Could not locate the bindings file".
- `AGENTS.md` diz "baseline 154 testes". Está desatualizado: o baseline real é 202.
- Não há ESLint, Prettier, CI (`.github/` ausente) nem e2e. O gate de qualidade depende de disciplina manual.
- Working tree sujo: 26 arquivos modificados e 5 não rastreados (sugestão de categorias, datas de parcela, testes do client, `opencode.jsonc`, `.gitattributes`). Esse trabalho precisa ser commitado ou descartado antes de qualquer refatoração.
- Git avisa CRLF em ~20 arquivos. O `.gitattributes` só cobre `.opencode/**` e `opencode.jsonc`. Vale um `* text=auto eol=lf` e uma normalização única.
- Arquivos grandes demais para evoluir com segurança:
  - `client/src/pages/ImportsPage.tsx` — 3.095 linhas, 20+ `useState` no mesmo componente.
  - `server/src/services/import.ts` — 1.783 linhas (leitura de planilha, mapeamento, parsing, duplicidade, transferências, categorias, gravação e modelos no mesmo arquivo).
  - `client/src/pages/TransactionsPage.tsx` — 1.562 linhas.
- Convenções do `AGENTS.md` não seguidas no Módulo 1: rotas de `bills.ts` não usam Zod (todas as outras usam `parseWith`), `readMultipart(request: any)` sem justificativa, e o parser multipart está duplicado entre `routes/bills.ts` e `routes/imports.ts`.
- Dois JPGs na raiz (`tela-de-lançamentos.jpg`, `tela-de-consolidacao.jpg`) são referências visuais de terceiros (um dashboard de transações estilo Dribbble e a tela de orçamento anual do app Spendle). Úteis como inspiração; devem ir para `docs/referencias/` ou sair do repositório.

### 1.3 A pasta `.opencode`

Há valor real ali, independentemente da ferramenta:

- **Pipeline com gates** (`lead.md`): G0 planner → G1 implementer → G2 test-author → G3 reviewer + security → G4 qa → G5 regression → G6 git-commit. Regras boas: "evidência ou não aconteceu", uma mudança por ciclo, máximo de dois ciclos por gate, nunca push sem humano.
- **Formato de plano** (`planner.md`): critérios de aceite testáveis antes do design, contratos em TypeScript, passos de 15–30 min com teste associado, riscos e rollback. Esse formato serve diretamente para planejar a fase 2.
- **QA e regressão** (`qa.md`, `regression.md`): matriz de risco por dimensão (entrada inválida, limites, estado, resiliência, dispositivo) e comparação com baseline, tratamento de flaky 3×.
- **Permissões por agente**: planner/reviewer read-only; push, `reset --hard`, `--no-verify` sempre negados.

Pontos fracos: todos os agentes apontam para `opencode/glm-5.3-flash-free` (modelo leve para um importador com essa complexidade); limites de passos baixos (8–16) para tarefas que tocam arquivos de 3 mil linhas; os comandos `plan/fix/review/gate/ship` dependem de um lead que ainda não tem como rodar e2e.

Recomendação: manter os **formatos** (plano, QA, regressão, commit) como padrão do projeto, inclusive para sessões com Claude; os gates viram checklist de PR quando houver CI.

---

## 2. Módulo 1 — Contas a pagar

### 2.1 Como está

Modelo `scheduled_bills`: descrição, valor, vencimento, status (`''`/`AG`/`PG`), categoria, `repeated_from_id`. Lista por mês, cartões de resumo (previsto, não pago, pago, quantidade), ordenação no cliente, modal de criar/editar, exclusão, select de status por linha, prompt "repetir no mês seguinte" ao marcar PG, importação CSV/Excel.

### 2.2 Problemas encontrados

| # | Problema | Onde | Impacto | Status (2026-11-12) |
|---|---|---|---|---|
| M1-01 | Não existe **recorrência**: "repetir" é um clone manual de uma ocorrência, sem regra (mensal/semanal/anual, dia fixo, fim, valor variável) nem projeção futura | `services/bills.ts` `repeatBill` | O usuário precisa marcar PG para a próxima conta nascer; não há visão de "próximos meses" | **Resolvido** (#6, #9): recorrência mensal/semanal/anual com término por data ou quantidade, geração automática e edição "desta em diante" |
| M1-02 | Conta não tem **conta/forma de pagamento** nem **vínculo com o lançamento** que a pagou | schema `scheduled_bills` | Impossível conciliar com o Módulo 2; "PG" é só uma flag | **Resolvido** (#6, #7): conta padrão e vínculo opcional com o lançamento (`bill_payments`) |
| M1-03 | Status é um código opaco (`''`, `AG`, `PG`) sem data de pagamento, valor pago, "pulada" ou "parcial" | schema + UI | Relatórios e histórico ficam pobres; "AG" (agendado) não diz quando | **Resolvido** (#6): `state` aberta/paga/pulada, `paid_at`, `paid_cents`, `scheduled_for`; parcial só no modelo |
| M1-04 | Listagem carrega **todas** as contas e filtra `startsWith(mês)` em JS | `listBills` | Funciona hoje; vira gargalo com histórico de anos. Deve ser `where due_date between` | **Resolvido** (#6): consulta por intervalo no SQL |
| M1-05 | Rotas sem Zod, `request: any`, multipart duplicado | `routes/bills.ts` | Fora do padrão do projeto | **Resolvido** (#8): Zod em todas as rotas, multipart compartilhado, sem `any` |
| M1-06 | Duplicidade de importação calculada duas vezes (preview e import) com a mesma lógica copiada | `bills-import.ts` | Risco de divergir | Pendente: a importação de contas por planilha (`bills-import.ts`) não foi tocada |
| M1-07 | Tela sempre volta ao mês atual ao montar; sem filtros, busca, ações em massa ou atalhos | `BillsPage.tsx` | Perde contexto ao navegar entre páginas | **Resolvido em parte** (#9): mês e filtros na URL, busca, filtro por situação e categoria; ações em massa e atalhos pendentes |
| M1-08 | "Vencida" calculada no cliente com `new Date()` local; nenhuma visão "vence hoje" / "próximos 7 dias" / "atrasadas" | `isPastDue` | O principal job do usuário (não atrasar) não tem uma tela própria | **Resolvido** (#6, #9): situação derivada no servidor e agenda de atrasadas, hoje e próximos 7 dias |
| M1-09 | Sem lembretes/notificações, sem anexos (boleto/PDF), sem linha digitável, sem observações | — | Funcionalidades básicas dos apps de referência | **Resolvido em parte**: lembretes por e-mail (PR 3) e contador no menu (#9); observações existem; anexos e linha digitável pendentes |

### 2.3 O que os apps de referência fazem

- **Actual Budget — Schedules**: a regra de recorrência é uma entidade separada das transações; o app **procura no histórico lançamentos que batem com a regra** e oferece vincular; botão "Find schedules" sugere recorrências a partir do histórico; "upcoming length" define quantos dias à frente aparecem no extrato. Fontes: [docs/schedules](https://actualbudget.org/docs/schedules), [tour/schedules](https://actualbudget.org/docs/tour/schedules), [release 26.9.0](https://actualbudget.org/blog/release-26.9.0), [release 25.10.0](https://actualbudget.org/blog/release-25.10.0/).
- **Firefly III — Bills / Recurring / Rules**: contas fixas (bills) com faixa de valor esperado e periodicidade; **regras** (gatilhos por descrição/valor/conta) vinculam lançamentos importados automaticamente à conta fixa; o FAQ do importador avisa que lançamento manual raramente casa com o importado, então o fluxo correto é "importar e deixar a regra vincular". Fontes: [recurring](https://docs.firefly-iii.org/how-to/firefly-iii/finances/recurring/), [subscriptions](https://docs.firefly-iii.org/explanation/financial-concepts/subscriptions/index.md), [rule triggers](https://docs.firefly-iii.org/references/firefly-iii/rule-triggers/), [FAQ do importador](https://docs.firefly-iii.org/references/faq/data-importer/import/index.md).
- **YNAB — Scheduled transactions** e **Banktivity**: ocorrência futura aparece no extrato como "upcoming", e "pagar" converte a ocorrência em transação real. Fontes: [YNAB](https://support.ynab.com/en_us/scheduled-transactions-a-guide-BygrAIFA9.md), [Banktivity](https://banktivity.com/help/v9/transactions/scheduled.php).
- **Organizze / Mobills**: cadastro com vencimento + notificação, recorrência para contas fixas, controle de cartões, "pagar" gera despesa na conta escolhida. Fontes: [Serasa](https://www.serasa.com.br/minhas-contas/blog/lembrete-contas-pagar/), [Na Prática 2026](https://napratica.org.br/noticias/os-melhores-apps-gratuitos-para-controle-de-gastos-mensais-de-2026), [Mobills FAQ](https://www.mobills.com.br/privacidade-e-termos/perguntas-frequentes/).

Padrão comum: **regra de recorrência ≠ ocorrência ≠ pagamento**, e o pagamento é um lançamento real vinculado.

### 2.4 Propostas — backend

1. **Novo modelo em três camadas** (migração com backup prévio, sem apagar `scheduled_bills`; migrar dados):
   - `bill_templates` (regra): descrição, valor esperado (fixo ou faixa min/max), categoria, conta/forma de pagamento padrão, recorrência (`none | weekly | monthly | yearly`, intervalo, dia do mês, "último dia útil", data início/fim), ativo, observações.
   - `bill_occurrences` (instância): `template_id` (nulo para conta avulsa), vencimento, valor previsto, status `scheduled | due_today | overdue | paid | partially_paid | skipped` (os três primeiros derivados por data, não gravados), `paid_at`, `paid_cents`, observações, anexo opcional.
   - `bill_payments` (vínculo): `occurrence_id` ↔ `transaction_id`, valor, origem (`manual | import_match | auto_rule`). Uma ocorrência pode ter N pagamentos (parcial) e um lançamento pode quitar N ocorrências (boleto agrupado).
2. **Gerador de ocorrências**: ao criar/alterar template, materializa as próximas N ocorrências (ex.: 12 meses) e um job idempotente ao abrir a tela garante a janela. Regras de calendário civil já existem em `lib/dates.ts` e `lib/installments.ts`; `addMonths` de `bills.ts` deve ir para `lib/dates.ts`.
3. **"Marcar como pago" cria lançamento** no Módulo 2 (data, valor, conta, categoria, descrição = conta) em transação SQLite, e grava `bill_payments`. Desfazer remove ambos. Isso é o elo com a conciliação.
4. **Auto-match na importação**: reaproveitar o padrão de `transfer-detection.ts` (candidatos com confiança + razões) para "lançamento importado parece pagar a ocorrência X" (valor igual ou dentro da faixa, vencimento ± tolerância, descrição similar via `lib/text-similarity.ts`). Mostrar na prévia como mais uma seção de revisão, nunca vincular silenciosamente.
5. **Endpoints**: `GET /api/bills?from&to&status`, `GET /api/bills/upcoming?days=7`, `POST /api/bills/:id/pay`, `POST /api/bills/:id/skip`, `POST /api/bills/:id/unpay`, CRUD de templates, `GET /api/bills/forecast?months=3`. Tudo com Zod em `routes/validation.ts`.
6. **Higiene**: consulta por intervalo de data no SQL (resolve M1-04), extrair `readMultipart` para `routes/multipart.ts`, unificar fingerprint de importação (M1-06), remover `any`.

### 2.5 Propostas — frontend / UX

1. **Tela orientada ao job "não atrasar"**: cabeçalho com três filas — *Atrasadas* (vermelho, sempre no topo), *Vence hoje / próximos 7 dias*, *Este mês*. Os cartões de resumo passam a ser clicáveis e viram filtros.
2. **Ação primária por linha: "Pagar"** (abre popover com data = hoje, valor = previsto, conta padrão do template) em vez de um `<select>` de código. Status vira *chip* colorido com ícone; "AG" vira *Agendado em DD/MM* com data real.
3. **Visão calendário / linha do tempo** do mês (ou lista agrupada por dia) ao lado da tabela, como fazem Mobills e Organizze; projeção de 3 meses com total previsto por mês.
4. **Recorrência visível**: ícone de repetição na linha, tooltip "mensal, dia 10, até dez/2026", e ao editar perguntar "só esta ocorrência / esta e as futuras" (padrão de calendário).
5. **Estado persistido na URL** (`?year=&month=&status=`) como já faz `TransactionsPage`, em vez de resetar para o mês atual.
6. **Filtros, busca e massa**: busca por descrição, filtro por categoria/conta/status, seleção múltipla com "marcar pagas" e "pular".
7. **Atalhos e microinterações**: `N` nova conta, `P` pagar selecionada, undo em toast ("Pagamento registrado · Desfazer"), empty state com CTA de importação/criação.
8. **Lembretes**: fase 1 = badge no menu lateral com atrasadas/vencendo (já existe o padrão de badge de seleção em `Layout.tsx`); fase 2 = notificação local (Web Notifications/PWA) com antecedência configurável no template.
9. **Acessibilidade**: tabela com `aria-sort`, foco visível, contraste dos chips nos dois temas (já há cuidado com cores de categoria).

---

## 3. Módulo 2 — Movimentos e importação

### 3.1 Pontos fortes (manter)

Parsing robusto de moeda/data/parcelas com rejeição de ambiguidade; prévia editável linha a linha; modelos de mapeamento por cabeçalho; duplicidade por impressão digital (idempotente); detecção de transferências com confiança/ambiguidade e rejeições com assinatura; sugestão de categoria em camadas com alias só após confirmação; recuperação de parcelas em lançamentos antigos; consolidado calculado sob demanda. A cobertura de testes dessa área é boa (addendo2/3/4, import, transfers).

### 3.2 Lacunas frente ao objetivo

| # | Lacuna | Proposta |
|---|---|---|
| M2-01 | **Não existe entidade "conta"**. `payment_methods` mistura conta corrente, cartão de crédito, VR/VA e dinheiro | Tabela `accounts` com `type` (`checking`, `savings`, `credit_card`, `investment`, `benefit_card`, `cash`), `institution`, `subtype` (VR/VA/VT), dia de fechamento e vencimento (cartão), cor/ícone. `payment_methods` migra para `accounts` (ou vira alias de conta) preservando ids |
| M2-02 | Reconhecimento de **formato por banco** depende só de aliases de cabeçalho genéricos | Catálogo de *perfis de arquivo* (fingerprint de cabeçalhos + nome do arquivo + delimitador) para Nubank (conta e cartão), Itaú, Inter, C6, BB (TXT), Caixa, Mercado Pago; cada perfil define mapeamento, tipo de conta sugerido, sinal e formato de parcela. Perfis desconhecidos caem no fluxo manual atual, que já é bom |
| M2-03 | Sem **OFX** | Parser OFX (SGML/XML) é pequeno; cobre a maioria dos bancos BR para conta corrente. Depende de aprovação de dependência (ou parser próprio) |
| M2-04 | Parcelas são linhas soltas; não há **grupo da compra** | `transactions.purchase_group_id` (ou tabela `installment_groups`) ligando as N parcelas de uma compra. Necessário para o Módulo 3 ("uma compra pode ter mais de uma movimentação") e para projeção de fatura |
| M2-05 | Lançamento não tem **rateio** (um movimento → várias categorias), tags, observações, anexos, status (`pending/cleared`) | `transaction_splits`, `tags`, `notes`, `attachments`; status para conciliação com extrato |
| M2-06 | Aliases só para categoria | **Regras** estilo Firefly: condição (descrição contém / valor / conta) → ação (categoria, conta, tag, marcar transferência, vincular conta a pagar). Reaproveita `category_import_aliases` como caso particular |
| M2-07 | Importação não pode ser **desfeita** | `import_batches` já existe: adicionar "desfazer lote" (apaga lançamentos do lote sem vínculo posterior; bloqueia se houver transferência/pagamento vinculado) |
| M2-08 | `import.ts` e `ImportsPage.tsx` monolíticos | Backend: `import/workbook.ts`, `import/mapping.ts`, `import/parse-row.ts`, `import/duplicates.ts`, `import/preview.ts`, `import/commit.ts`, `import/templates.ts`. Frontend: wizard com etapas (Arquivo → Mapeamento → Linhas → Transferências → Categorias → Contas a pagar → Duplicidades → Confirmar), estado em reducer/`useImportWizard`, um componente por etapa |
| M2-09 | Saldo por conta e fatura de cartão não existem | Com `accounts` + fechamento/vencimento: saldo projetado, fatura aberta/fechada, e "pagamento de fatura" como transferência conta→cartão (hoje é categoria `card_settlement`) |

Referências: formatos de exportação variam por banco e raramente são documentados ([Facilite — exportar OFX](https://www.facilite.co/como-exportar-arquivo-ofx-dos-principais-bancos), [bbvisa2ofx](https://pypi.org/project/bbvisa2ofx), [gist Nubank OFX→CSV](https://gist.github.com/renatomb/c9dfee9ffa95fb9e1815aa09b02cfa06)). Open Finance exige instituição autorizada pelo BC; para uso pessoal continua sendo arquivo exportado ([Neon](https://neon.com.br/aprenda/financas-pessoais/open-finance/), [Resolução Conjunta 1](https://normativos.bcb.gov.br/Lists/Normativos/Attachments/51028/Res_Conj_0001_v8_L.pdf)). Agregadores (Pluggy, Belvo) são B2B pagos; fora do escopo local-first.

### 3.3 UX da listagem

- Cartões de resumo estilo dashboard (receitas, despesas, resultado, transferências) já existem; falta **saldo por conta** e gráfico simples de tendência mensal.
- Edição inline é boa; adicionar **rateio** e **tags** no mesmo drawer.
- Consolidado anual: manter a grade 12 meses (é o diferencial da planilha); adicionar comparação com **orçamento por categoria** (coluna "meta" e célula colorida quando estoura, como no Spendle da referência) — opcional, mas barato com a estrutura atual.

---

## 4. Módulo 3 — Compras (NFC-e)

### 4.1 Realidade técnica da NFC-e

- O QR code da NFC-e aponta para o portal estadual com a **chave de acesso de 44 dígitos** e parâmetros. A consulta pública completa exige **captcha** na maioria das SEFAZ, as URLs mudam com frequência e a cobertura por estado é desigual ([Contmatic 2026](https://simplifique.contmatic.com.br/blogs/consulta-nfc-e-2026), [NFE.io](https://nfe.io/blog/nota-fiscal/consulta-nfce/), [Focus NFe](https://focusnfe.com.br/blog/como-consultar-nota-fiscal-de-terceiros/)). APIs pagas existem, mas majoritariamente para NF-e ([Invoisys NFC-e por chave](https://integracao.gitbook.io/invoisys/endpoints/emissao-notas/nfc-e-1/api-consulta-nfc-e-por-chave-de-acesso)).
- Conclusão: **não fazer scraping**. O QR code serve para extrair a chave (identidade única da compra, evita duplicidade) e o UF; o conteúdo entra por outros canais.

### 4.2 Canais de entrada propostos (em ordem de esforço)

1. **Texto colado** da página do portal (Ctrl+A/Ctrl+C) — parser por heurística de linhas (código, descrição, qtd, unidade, valor unit., total) e bloco "Formas de pagamento".
2. **HTML/PDF salvo** da página — mesmo parser após extração de texto (`pdf-parse` ou similar; dependência a aprovar).
3. **JSON** — contrato próprio documentado, útil para scripts/extensão de navegador e testes.
4. **Imagem (print)** — OCR local (`tesseract.js`) em fase posterior; qualidade é variável e exige revisão manual.
5. **Leitura do QR** no navegador (câmera, `BarcodeDetector` ou lib) apenas para preencher chave/UF e abrir o portal.

Toda entrada passa por uma **prévia editável** igual à da importação de planilha: cabeçalho da nota, itens com correção inline, formas de pagamento.

### 4.3 Modelo de dados

- `suppliers` (CNPJ raiz, razão social, nome fantasia) e `supplier_branches` (CNPJ completo, endereço/cidade/UF) — "filial comprada".
- `purchases`: `access_key` (único), `supplier_branch_id`, `issued_at`, `total_cents`, `discount_cents`, `source` (`text | pdf | json | image | manual`), `raw_payload` (texto original para auditoria).
- `purchase_items`: `purchase_id`, ordem, `raw_description`, `code`, `quantity` (decimal em milésimos), `unit` (texto cru), `unit_price_cents`, `total_cents`, `discount_cents`, `product_id` (nulo até o Módulo 4).
- `purchase_payments`: `purchase_id`, `kind` (`cash | debit | credit | pix | benefit_card | voucher | cashback | bonus | other`), `amount_cents`, `installments` (se crédito).
- `purchase_settlements`: `purchase_payment_id` ↔ `transaction_id` (N:N), valor conciliado, origem (`manual | auto`). Pagamentos em `cash`, `cashback` e `bonus` podem ser marcados como **"não gera movimento"** ou mapeados para uma conta `cash`/receita de cashback — decisão do usuário, com padrão configurável.

### 4.4 Conciliação M2 ↔ M3

- Candidatos: lançamentos na conta compatível com o `kind`, data entre emissão e emissão + N dias (cartão: parcelas via `purchase_group_id` do M2-04), valor igual ao pagamento (ou à soma das parcelas), descrição com nome fantasia do fornecedor (similaridade).
- Tela de conciliação dedicada, reaproveitando o layout lado a lado de `ReconciliationPage` (transferências), com estados *conciliada / parcial / sem movimento / sem compra*.

O Módulo 4 fica para depois, mas `purchase_items` já guarda descrição crua, quantidade e unidade para que a normalização de produto (ex.: "coca-cola 1,5l" vs "2,5l" → litro) seja feita sem reimportar notas.

---

## 5. Arquitetura, monorepo e caminho para mobile

### 5.1 Manter a stack

Fastify + React + SQLite + Drizzle + Zod + Vitest atendem bem ao caso (local-first, sem serviço pago). Trocar framework agora custaria mais do que entrega; o problema é **organização**, não tecnologia. Dois ajustes de ferramenta valem a pena: `fastify-type-provider-zod` (schemas Zod viram validação + OpenAPI) e, no client, trocar `fetch` manual por um cliente tipado gerado a partir dos mesmos schemas.

### 5.2 Layout proposto do monorepo

```
apps/
  api/        Fastify (hoje server/) — rotas finas, sem regra de negócio
  web/        React + Vite (hoje client/)
  mobile/     (futuro) Expo / React Native
packages/
  domain/     TS puro, sem Node/DOM: money, dates, installments, normalize,
              text-similarity, parsers (planilha/OFX/NFC-e), detectores
              (transferência, pagamento de conta, compra), schemas Zod e tipos DTO
  db/         schema Drizzle + migrações + repositórios
  api-client/ cliente HTTP tipado (gerado dos schemas) usado por web e mobile
  ui/         (futuro) componentes compartilháveis entre web e mobile
docs/
```

Regra de dependência: `apps → packages`; `domain` não importa nada de `db`, `api` ou React. Isso permite testar toda a regra de negócio sem banco e reutilizá-la no mobile.

Passos de migração (cada um um PR pequeno, sem mudar comportamento):
1. Criar `packages/domain` movendo `server/src/lib/*` e os tipos de `client/src/lib/types.ts`; o server passa a importar de lá.
2. Mover schemas Zod de `routes/validation.ts` para `domain`; gerar tipos do client a partir deles.
3. Quebrar `services/import.ts` em módulos (seção 3.2, M2-08) — sem mudar testes.
4. Quebrar `ImportsPage.tsx` em etapas do wizard.
5. Renomear `server/` → `apps/api`, `client/` → `apps/web` (último passo, só mecânico).

### 5.3 Mobile

- **Fase A (barata):** PWA — manifest, service worker, layout responsivo (hoje é desktop-first com sidebar colapsável). O servidor roda num PC/NAS e o celular acessa pela rede local ou Tailscale. Cobre leitura de QR pela câmera e consulta rápida de contas a pagar.
- **Fase B:** Expo consumindo `packages/api-client` e `packages/domain`. Mesmo backend.
- **Fase C (se precisar offline):** SQLite no dispositivo + sincronização. Preparar desde já: `uuid` público nas tabelas principais além do `id` inteiro, `updated_at` em todas, e exclusão lógica onde houver sync.

### 5.4 Qualidade de engenharia

- ESLint (typescript-eslint + react-hooks) e Prettier, com `npm run lint` no gate.
- CI no GitHub Actions: `npm ci`, `npm run build`, `npm test` em Linux (teria pegado o binário nativo ausente).
- Testes de componente no client (Testing Library) para o wizard de importação e a tela de contas; Playwright para um fluxo e2e de importação com `sample-finance.csv`.
- Atualizar `AGENTS.md` (baseline 202, comandos reais, estrutura nova) e README (comandos Linux/macOS além de `npm.cmd`).

---

## 6. Priorização sugerida

### Fase 0 — higiene (1 PR curto) — concluída (CI, baseline, reset, referências movidas; ESLint/Prettier pendentes)
Commit/fechamento da branch atual · `.gitattributes` global · `AGENTS.md` baseline · ESLint/Prettier · CI · mover JPGs para `docs/referencias/`.

### Fase 1 — Módulo 1 (foco pedido) — concluída em 2026-11-12, exceto notificações locais
1. ~~Modelo templates/ocorrências/pagamentos + migração dos dados atuais (backup antes).~~ #6
2. ~~Rotas com Zod, consulta por intervalo, "pagar" criando lançamento.~~ #7, #8
3. ~~Tela nova: filas (atrasadas/hoje/7 dias/mês), chip de status, popover de pagamento, URL persistente, filtros.~~ #9
4. ~~Recorrência com geração de ocorrências e edição "só esta / esta e futuras".~~ #6, #9
5. ~~Auto-match de pagamentos na importação (seção da prévia).~~ #10, #11
6. ~~Badge no menu~~ (#9) + notificações locais (pendente; entra com a PWA).

### Fase 2 — Módulo 2
Contas (`accounts`) e tipos · perfis de arquivo por banco · OFX · grupo de parcelas · rateio/tags · regras · desfazer lote · quebra de `import.ts`/`ImportsPage.tsx` em wizard.

### Fase 3 — Módulo 3
Modelo compras/fornecedores/itens/pagamentos · entrada por texto e JSON · prévia editável · conciliação com M2 · depois PDF e OCR.

### Transversal
`packages/domain` e `api-client` começam na Fase 1 (as regras novas já nascem lá); PWA ao final da Fase 2.
