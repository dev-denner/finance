# Revisão da branch `feat/module3-purchases` (Módulo 3 — Compras / NFC-e)

Data: 2026-11-11 · Base comparada: `origin/master` (7676fe5) · Ponta revisada: 5c03ee6

## Veredito: APROVADO COM RESSALVAS

Build verde e suíte verde no worktree isolado (418 testes no server, 53 no client). Nenhum `console.log` novo fora dos CLIs, nenhum `any` novo. O desenho de dados converge com o que a análise de módulos propôs; as ressalvas são de integração (migração `0007` duplicada com a branch de contas a pagar), de uma regra de conciliação que sobrescreve classificação por item, e de manutenção (commits gigantes, parser RJ sem teste próprio, `lib: DOM` no server inteiro).

## O que a branch entrega

- **Modelo**: `purchases` (chave de acesso única, fornecedor inline com CNPJ, totais, desconto, forma de pagamento textual), `purchase_items` (posição, descrição, quantidade, unidade, preços, categoria opcional), `purchase_settlements` (liquidação N:N com lançamentos ou carteiras, `reversed_at` para desfazer) e `payment_balance_adjustments` (créditos iniciais, cashback, bônus). `payment_methods` ganha `balance_type` (`credit | debit | wallet | unclassified`) e saldo cronológico não negativo para débito/carteira.
- **Canais de entrada**: URL do QR Code (RJ, SP, TO) via Chrome headless com Playwright; PDF textual (RJ, MG) via `pdfjs-dist`; texto colado de uma ou várias notas; lote CSV/TXT de URLs. Prévia antes de gravar em todos; deduplicação por chave de acesso; nada parcial é salvo.
- **Guardas de consulta**: 10 consultas por UF em 24 h, 30 s entre consultas, pausa de 72 h no RJ após aviso de bloqueio por IP, DNS pinning, allow-list de hosts, limites de tempo/tamanho/requisições, sem captcha, proxy ou stealth. Estado em `server/data/nfce-query-guard.json`.
- **Conciliação M2 ↔ M3**: candidatos por valor ≤ total, até 7 dias, excluindo transferências e liquidação de cartão; pagamentos parciais combináveis; carteiras com ajuste retroativo; desfazer auditável. Categoria por compra e por item.
- **Client**: Importações vira hub (movimentações e NFC-e), tela Compras com lista por período, detalhe, classificação de itens e painel de conciliação. Rotas e menu atualizados.

## Alinhamento com `docs/analise-modulos-2026-11.md`

| Proposta da análise | Na branch | Observação |
|---|---|---|
| Não fazer scraping; QR só para extrair chave | **Parcial**: automatiza o portal com navegador, mas com guardas honestas | Ver R2 |
| Entrada por texto colado, PDF, JSON, imagem | Texto e PDF prontos; JSON e OCR ausentes | JSON é barato e serve para testes/extensão |
| `purchases`, `purchase_items`, `purchase_settlements` N:N | Igual em essência | Convergência boa |
| `purchase_payments` (formas de pagamento da nota) | Só `paymentMethod` textual | Nota traz múltiplas formas; perde o rateio |
| Dinheiro/cashback/bônus sem lançamento | `wallet` + `payment_balance_adjustments` | Atende, com auditoria |
| Entidade `accounts` com tipo (M2-01) | `payment_methods.balance_type` | É o embrião certo; evoluir aqui em vez de tabela nova |
| Itens guardam descrição/qtd/unidade cruas para o Módulo 4 | Sim | Falta o **código do produto** (cProd/EAN) que a nota traz |

## Ressalvas e recomendações

### R1 — Migração `0007` em conflito com `feat/bills-recurrence`
Ambas as branches criam uma `0007`. Simulação de merge (`git merge-tree`): `schema.ts` e `README.md` mesclam sozinhos; conflitam `meta/_journal.json`, `meta/0007_snapshot.json`, `src/db/reset.ts` e `tests/reset.test.ts`. **Recomendação:** mesclar esta branch primeiro (oito migrações, mais churn); em seguida a branch de contas a pagar renumera a sua para `0015`, regenera o snapshot e une as listas do reset (`purchase_*` → `bill_payments` → … → `scheduled_bills` → `bill_templates`).

### R2 — Consulta aos portais com navegador headless
Funciona hoje e o código é cuidadoso, mas é o caminho frágil: depende do layout de três portais, já registrou bloqueio por reputação de IP no RJ (o código trata explicitamente) e pode esbarrar em termos de uso. **Recomendação:** manter como canal opcional atrás de configuração (desligado por padrão), com texto colado e PDF como caminhos principais na interface; registrar no README que o canal pode parar sem aviso.

### R3 — Conciliar sobrescreve a categoria de todos os itens
`reconcilePurchase` aplica a categoria da compra a **todos** os `purchase_items`, guardando a anterior em `reconciliation_previous_category_id` e restaurando no desfazer. Isso apaga a classificação item a item feita antes de conciliar, contrariando o README ("essa classificação é independente da categoria geral da compra"). **Recomendação:** aplicar só aos itens sem categoria, ou tornar a propagação uma escolha explícita no payload.

### R4 — `purchases.transaction_id` redundante
Com `purchase_settlements` como fonte da verdade, `transaction_id` guarda só o primeiro movimento e tem índice único, o que impede duas compras parciais pagas pelo mesmo lançamento mesmo quando as liquidações permitiriam. **Recomendação:** remover a coluna (ou renomear para "movimento principal" e tirar a unicidade) em uma migração própria.

### R5 — Migração `0014` repete o padrão frágil de rebuild
`PRAGMA foreign_keys=OFF` dentro do migrator do Drizzle não tem efeito (roda em transação). Aqui não há dano porque nada referencia `purchase_settlements`, mas o mesmo padrão derrubaria filhos com `ON DELETE CASCADE` em outra tabela. A migração `0007` da branch de contas a pagar documenta o contorno (tabelas auxiliares).

### R6 — Qualidade e manutenção
- Commits de 6,9 mil, 16 mil e 1,9 mil linhas; o `AGENTS.md` pede commits atômicos. Em PRs futuros, um por canal (QR, PDF, texto, lote, conciliação).
- `server/tsconfig.json` passou a incluir `lib: DOM` para o server inteiro (por `pdfjs-dist` e `DOMParser`). Isola com `/// <reference lib="dom" />` nos dois arquivos que precisam, para `document`/`window` não aparecerem como tipos válidos no backend.
- O parser RJ (`parseRjNfceSnapshot`) só é exercitado indiretamente em `purchases.test.ts`; SP e TO têm arquivos próprios. Vale um `rj-nfce.test.ts` com snapshot de DOM fixo.
- Mensagens de saldo exibem centavos crus ("faltam 1234 centavos em 2026-01-01"); formatar em BRL e data `DD/MM/AAAA`.
- Tokens de prévia ficam em memória (`Map`, 10 min, 100 entradas): somem em restart. Aceitável para app local; documentar.
- Dependências novas (`playwright-core`, `pdfjs-dist`) exigem Chrome/Chromium instalado; o README avisa, o CI não instala navegador (os testes do navegador são unitários, então passam).
- `AGENTS.md` da branch ainda diz baseline 362; o real nela é 471.
- `TransactionsImportPage.tsx` (3.048 linhas) é a antiga `ImportsPage` renomeada: o wizard por etapas continua pendente.

### R7 — Dados para o Módulo 4
Guardar o **código do item** (`cProd`, EAN quando houver) em `purchase_items` já nos parsers atuais evita reimportar notas depois; e separar as formas de pagamento da nota em linhas (`purchase_payments`) permite conciliar cartão + dinheiro + VR na mesma compra sem depender do texto.

## Ordem sugerida
1. Mesclar `feat/module3-purchases` após ajustar R3 (regra de itens) e atualizar o baseline.
2. Rebasear `feat/bills-recurrence` sobre o resultado, renumerando a migração para `0015`.
3. Abrir issues pequenas para R4, R6 (tsconfig, teste RJ, mensagens) e R7.
