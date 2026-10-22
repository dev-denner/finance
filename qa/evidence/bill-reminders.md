# Evidência — Lembretes por e-mail para contas não agendadas (Módulo 1)

Branch: `feat/bill-reminders-email` (base: `feat/import-installments-category-matching` @ `d03bbbb`)

## Localização do Módulo 1

- **Módulo 1 = Bills/Contas**: `server/src/services/bills.ts`, `server/src/routes/bills.ts`, `client/src/pages/BillsPage.tsx`.
- **Entidade do item do calendário**: `scheduled_bills` (`server/src/db/schema.ts:186`).
- **Data do calendário**: `dueDate` (TEXT ISO `AAAA-MM-DD`).
- **Estado "agendado"**: `status` — `''` = pendente (não agendado) · `'AG'` = agendado · `'PG'` = pago.
  `export type BillStatus = '' | 'AG' | 'PG'` (`server/src/services/bills.ts:11`); check no banco `status IN ('','AG','PG')` (`schema.ts:206`).
  O alvo dos lembretes é `status = ''`. `'AG'` e `'PG'` **não** são avisados.
- A UI mostra os códigos crus `AG`/`PG` (`client/src/pages/BillsPage.tsx:396-397`).

## Autorizações concedidas (usuário, 2026-10-21)

| # | Item | Autorizado |
|---|---|---|
| 1 | Migração/schema | **2 tabelas novas** (aditivas), com `npm run db:backup` antes |
| 2 | Mecanismo de job | **agendador interno + CLI** |
| 3 | Dependência de e-mail | **`nodemailer@10.2.0`** (carregado dinamicamente) |
| 4 | Variáveis de ambiente | 10 novas, documentadas no README |
| 5 | Credencial/serviço pago | **NÃO** — nada pago, nada de terceiros |

Backup feito: `server/backups/finance-2026-10-21T22-52-01-710Z.db` (diretório ignorado pelo git).

## Decisões de design (G0)

- **D1 Idempotência**: 2 tabelas.
  - `bill_reminder_batches` — 1 e-mail por (marco, data-alvo). `UNIQUE(milestone, send_date)`. Guarda `state`, `attempts`, `last_error`, `sent_at`, `item_count`, `recipient`.
  - `bill_reminder_notifications` — ledger por (item, marco). `UNIQUE(bill_id, milestone, due_date)`. `state` em `pending|sent|failed|skipped`, `attempts`, `last_error`, `sent_at`, `batch_id`.
  - `bill_id` com `ON DELETE CASCADE` (item excluído apaga o ledger dele).
  - `due_date` entra na chave: alterar o vencimento gera um conjunto novo de marcos; a linha antiga vira `skipped`.
- **D2 Job**: núcleo puro `runBillReminders` + agendador interno ligado **apenas** em `server/src/index.ts` (nunca em `buildApp`, que é usado por 4 arquivos de teste) + CLI `npm run reminders:run [-- --today=AAAA-MM-DD] [--dry-run]`.
  Tick de 30 min; na subida roda um *catch-up*. "Hoje" é recalculado a cada tick em São Paulo.
- **D3 Datas**: `todayIsoInTimeZone(tz='America/Sao_Paulo')` via `Intl.DateTimeFormat` + `formatToParts` (não depende do TZ do host). `addDaysIso` e `daysBetweenIso` novos em `server/src/lib/dates.ts` (aritmética de calendário em UTC, imune a DST). `todayIso()` existente fica **intocado** (não tem uso hoje, mas é `export` público).
- **D4 Transporte**: interface `ReminderTransport` + `DryRunTransport` (dev, sem dependência) + `FakeTransport` (testes, pode falhar de propósito) + `SmtpTransport` (nodemailer, `await import()` dinâmico, só com `BILL_REMINDER_TRANSPORT=smtp` e credenciais presentes).
- **D5 Conteúdo do e-mail**: entra **descrição, data de vencimento (DD/MM/AAAA), categoria, contagem e marco**. **NÃO entra `amountCents`**, nem total, nem qualquer valor. A garantia é **estrutural**: o tipo `ReminderItemView` que chega ao renderizador não tem o campo `amountCents` → impossível vazar por engano (o compilador reclama).
- **D6 Falha de envio**: marca `sent` só **depois** do transporte resolver. Falha → `state='failed'`, `attempts+1`, `last_error` truncado e sanitizado. Retentativa na execução seguinte; e-mail já `sent` nunca é reenviado. `Message-ID` determinístico por lote (`<bill-reminder-D-3-2026-10-22@finance.local>`) para dedup no cliente de e-mail.
  - **Regra final (rodada 2 do G1)**: uma notificação `failed` **nunca** é descartada como "marco perdido" — ela é **reenviada** (a mais antiga do item) até ser confirmada. A seleção entrega **1 aviso novo** (de `pending`) + **1 retentativa** (de `failed`) por item/execução.
  - **Texto do e-mail**: o corpo diz "Aviso enviado em {hoje}" (a data real do envio, nunca a data antiga do marco). No aviso atrasado, o assunto ganha o sufixo "— recuperação" e o corpo explica que o marco já havia passado. A data de **vencimento** de cada item permanece na lista — é a referência real do prazo.

## Fluxo do núcleo `runBillReminders`

1. `windowStart = addDaysIso(today, -3)`; elegíveis `windowStart <= sendDate <= today`, onde `sendDate = addDaysIso(dueDate, -offset)`.
2. Criação idempotente: `INSERT OR IGNORE` na notificação para cada (item, marco) elegível e com `status = ''`.
3. Limpeza → `skipped`: conta deixou de estar pendente; vencimento alterado; `sendDate` fora da janela.
4. Seleção — **regra final, revisada na rodada 2 do G1** (o texto original do plano, "escolhe o marco mais antigo pendente", produzia enxurrada: com o tick de 30 min, o item recebia D-3, D-2 e D-1 no mesmo dia):
   - candidatos = `pending|failed` com `sendDate <= today`, **JOIN** `scheduled_bills` exigindo `status = ''` e `due_date` igual à registrada;
   - **1 aviso novo** por item/execução, a partir de `pending`: o marco **nominal do dia** (`sendDate == today`) se existir; senão o marco **perdido mais antigo** (o *catch-up*);
   - **1 retentativa** por item/execução, a partir de `failed`: o `failed` mais antigo é **sempre reenviado** — envio não confirmado não é aviso novo, é continuação de um aviso já iniciado. `failed` **nunca** vira `skipped` pela seleção;
   - `pending` perdidos não escolhidos ⇒ `skipped` ("marco perdido: coberto pelo aviso de hoje" / "…pelo aviso de recuperacao");
   - `failed` não escolhidos ⇒ **continuam `failed`** (retentados um por vez depois);
   - `pending` nominais não escolhidos ⇒ **continuam `pending`** para o dia seguinte;
   - **no máximo 1 e-mail por item por dia no caminho normal** (sem falha) — é isso que impede a enxurrada quando o servidor volta depois de dias fora;
   - com falha de envio, o item pode levar **2 e-mails no mesmo dia** (1 aviso novo + 1 retentativa): aceitável, porque só um deles é um aviso novo.
5. Envio agrupado por (marco, data-alvo) → **1 e-mail por marco/dia**. O lote é o *claim* atômico (ver correção do BUG-01 abaixo): só quem cria/reativa o lote envia. Lote já `sent` mantém a notificação `pending` e registra o motivo em `last_error` (o item continua sinalizado para o próximo marco).
6. Resumo com contagens, sem PII.

## QA do ciclo anterior — P2 e correção (rodada 2)

O QA do ciclo do commit `5f38d3c` aprovou os 11 AC, sem P1. Ficaram abertos
**2 P2** — corrigidos nesta rodada —, 1 P3 e 2 P4 (mantidos fora desta
correção, por escopo). A reprodução original está nas sondas externas
`/tmp/opencode/qa/probe-concurrency.mts` e `probe-extra.mts` (duas conexões no
mesmo banco temporário; nenhum e-mail real).

### BUG-01 (P2) — aviso duplicado na concorrência CLI × agendador

- **Causa raiz**: o lote era gravado como `pending` **antes** do envio
  (`bill-reminders.ts`, INSERT com commit imediato) e qualquer lote
  não-`sent` era tratado como retentativa. Entre o INSERT e a gravação de
  `sent`, o segundo processo lia `pending` e reenviava o mesmo marco. O índice
  único `(milestone, send_date)` protegia só a criação do lote, não o intervalo
  em voo.
- **Correção (sem schema/migração/dependência nova)**: o lote é o *claim*
  atômico.
  - lote novo: `INSERT ... state='pending'` — o índice único decide o vencedor;
  - retentativa: `UPDATE ... SET state='pending' WHERE id=? AND state='failed'`
    — só um processo obtém `changes=1`;
  - `pending` recente = envio em voo: o outro processo pula **sem tocar nas
    notificações** (evita sobrescrever `sent` com `skipped`);
  - `pending` abandonado (processo interrompido): retomado só após
    `STALE_BATCH_CLAIM_MINUTES = 30`, por compare-and-swap em `updated_at`;
  - lote `sent` mantém a auditoria existente (notificação continua pendente
    para o próximo marco).
- **Garantia**: *at-least-once*. Com processos saudáveis, no máximo um envio
  por lote. Duplicata só é possível se o processo cair/pausar **depois** de o
  SMTP aceitar a mensagem e **antes** do commit de `sent`, ou se o envio
  exceder a janela de abandono. Não é "exactly once" — o SMTP não participa da
  transação do banco. O `Message-ID` determinístico ajuda o cliente a
  deduplicar.

### BUG-02 (P2) — API só começava a escutar depois do primeiro envio

- **Causa raiz**: `index.ts` aguardava `scheduler.start()`, que aguardava
  `runNow()` → `transport.send()` antes de `app.listen()`. Um SMTP lento ou
  caído mantinha a API fora do ar pelos timeouts do nodemailer.
- **Correção**: `start()` arma o timer e dispara o catch-up **em segundo
  plano**, resolvendo imediatamente; `whenIdle()` permite aguardar o ciclo em
  testes/encerramento. O `isRunning` continua impedindo sobreposição.

### Testes de regressão adicionados/atualizados

- `server/tests/bill-reminder-concurrency.test.ts` (4): corrida realista com
  duas conexões no mesmo arquivo temporário (agendador bloqueado no envio ×
  CLI), retentativa em outro processo, `pending` recente não reenviado e
  retomada de `pending` abandonado.
- `server/tests/bill-reminders.test.ts` (+1): `start()` resolve com o envio
  bloqueado (a API sobe).
- Atualizados: violação única do lote (o perdedor não consome a notificação),
  aguardos do catch-up via `whenIdle()` e a mensagem obsoleta da CLI.
- Suíte completa: **362** testes (336 server + 26 client), build verde.

## Critérios de aceite

| # | AC |
|---|---|
| AC-1 | Um item pendente recebe **no máximo 4 avisos** (D-3, D-2, D-1, D0) |
| AC-2 | Cada e-mail **consolida** todos os pendentes daquele marco (1 e-mail por marco/dia) |
| AC-3 | Sem alertas repetidos para o mesmo (item, marco) |
| AC-4 | Marcar como `AG` interrompe os avisos restantes |
| AC-5 | Falha de envio rastreável e retentável sem duplicar o já confirmado |
| AC-6 | Nenhum e-mail real em teste/dev |
| AC-7 | Preserva os dados financeiros e **não altera** o comportamento atual do calendário fora do fluxo |
| AC-8 | Dias restantes no fuso America/Sao_Paulo |
| AC-9 | Recupera marcos perdidos após o servidor ficar dias fora |
| AC-10 | O e-mail **não expõe valor monetário** |
| AC-11 | O e-mail diz explicitamente que os itens **precisam ser agendados** |

## Fora de escopo

WhatsApp e outros canais · valor no e-mail · UI de configuração no client · autenticação/multiusuário ·
reenvio deliberado de marcos · backup de lembretes · endpoint HTTP de disparo (fase 2) ·
correção do bug pré-existente de `reset:all` com `scheduled_bills`.

## Regras do ciclo

- Nada toca `server/src/services/bills.ts`, `server/src/routes/bills.ts`, `client/src/pages/BillsPage.tsx`, `client/src/lib/types.ts` nem `client/src/lib/api.ts` (AC-7).
- Fuso: `America/Sao_Paulo` é **constante** no código — não vira variável de ambiente.
- Nenhum e-mail real sai de teste/dev. O transporte `smtp` só é construído com `BILL_REMINDER_TRANSPORT=smtp` **e** todas as credenciais presentes.
- Sem `console.log`/`debugger`/`.only`/`.skip` no código entregue. `last_error` e o log nunca carregam valor, credencial ou PII.

## Auditoria de segurança — correção não commitada (branch `feat/bill-reminders-email`, base 5f38d3c)

Auditor: segurança (subagente). Escopo revisado: `server/src/services/bill-reminders.ts`,
`bill-reminder-scheduler.ts`, `bill-reminder-cli.ts`, `bill-reminder-smtp.ts`, `bill-reminder-config.ts`,
`server/src/db/client.ts`, `server/src/index.ts`, testes `bill-reminder*.test.ts` e docs. Nenhum arquivo
modificado, nenhum teste executado por falta de shell na sessão (suíte referenciada: 362 testes).

### Veredito: APROVADO COM RESSALVAS

| Severidade | Qtd |
|---|---|
| critical | 0 |
| high | 0 |
| medium | 0 |
| low | 3 |
| informativo | 3 |

### Achados

#### [LOW] SQLite sem `busy_timeout` no caminho padrão de abertura do banco — `server/src/db/client.ts:23` (A05/A04)
- **Cenário de ataque/impacto:** a CLI (`npm run reminders:run`) e o backend abrem o mesmo
  arquivo SQLite com conexões independentes e ambos podem escrever ao mesmo tempo. `createDatabase`
  não define `busy_timeout` (só `reset.ts` o faz em `runDatabaseReset`). Em WAL, leituras não
  bloqueiam, mas escritas concorrentes podem levantar `SQLITE_BUSY` e derrubar a CLI (código 1) ou
  abortar um ciclo do agendador (que vira `null`).
- **Prova (código):** `server/src/db/client.ts:18-36` — `pragma('foreign_keys')` e WAL, sem
  `busy_timeout`; `reset.ts:199` mostra o padrão adotado só no reset.
- **Correção mínima:**
```diff
  sqlite.pragma('foreign_keys = ON');
+ sqlite.pragma('busy_timeout = 5000');
```
- **Teste que evita reincidência:** teste de concorrência CLI × agendador com duas conexões
  escrevendo ao mesmo tempo (já existe `bill-reminder-concurrency.test.ts`).

#### [LOW] `--today` arbitrário na CLI antecipa a janela de envio — `server/src/services/bill-reminder-cli.ts:155-164` (A04)
- **Cenário de ataque:** qualquer processo local com acesso ao shell pode executar
  `npm run reminders:run -- --today=<data futura>`, deslocando `windowStart/windowEnd` e disparando
  avisos (com descrições de contas) antes do cronograma previsto. Não expõe valor monetário (AC-10),
  mas antecipa PII de descrição ao destinatário e pode ser usado para spam local.
- **Impacto:** baixo — exige acesso local ao host e às credenciais do SMTP já configuradas; o
  destinatário é o configurado.
- **Correção mínima (opcional):** restringir `--today` a uma data dentro de `[hoje-3, hoje]` ou exigir
  confirmação explícita quando a data for futura.
- **Teste que evita reincidência:** caso em `bill-reminder-cli.test.ts` rejeitando data futura.

#### [LOW] Log de erro inesperado não sanitizado — `server/src/services/bill-reminder-scheduler.ts:175-180` (A08)
- **Cenário de ataque:** `executeCycle` captura erros inesperados (ex.: falha de banco) e registra
  `error.message` bruto em `app.log`. O caminho de envio (transporte) sanitiza via
  `sanitizeReminderError` antes de logar (`bill-reminders.ts:834`), mas erros fora do transporte não
  passam por essa função. Em cenários de falha de infraestrutura a mensagem pode conter caminho do
  banco ou detalhes de conexão.
- **Impacto:** baixo — não inclui credencial SMTP nem valor monetário no caminho normal; risco
  residual de PII/caminho em log.
- **Correção mínima:**
```diff
  this.logger.error(
-   { error: error instanceof Error ? error.message : String(error) },
+   { error: sanitizeReminderError(error) },
    'Falha ao executar o ciclo de lembretes.',
  );
```
(importar `sanitizeReminderError` de `./bill-reminders`.)

### Informativos (sem ação obrigatória)

- **[INFORMATIVO] Garantia *at-least-once*, não *exactly-once*** — `bill-reminders.ts:60-65`. Duplicata
  só é possível se o processo cair/pausar **depois** de o SMTP aceitar a mensagem e **antes** do
  commit de `sent`, ou se o envio exceder a janela de abandono (30 min). Mitigado pelo `Message-ID`
  determinístico (`buildReminderMessageId`). Documentado no README.
- **[INFORMATIVO] Dry-run imprime destinatário e corpo no stdout** — `bill-reminder-cli.ts:116-135`.
  Comportamento esperado de simulação; evite redirecionar saída para logs compartilhados.
- **[INFORMATIVO] Recipient (e-mail) persistido em `bill_reminder_batches.recipient`** —
  `server/src/db/schema.ts:232`. Necessário para auditoria; backups contêm esse dado (já alertado no
  README: "Os backups guardam dados financeiros sensíveis").

### O que está correto (verificado)

- Claim atômico do lote: `INSERT` protegido por índice único + `UPDATE ... WHERE state='failed'` +
  compare-and-swap em `updated_at` para `pending` abandonado; perdedor não toca notificações
  (`bill-reminders.ts:655-752`).
- `sanitizeReminderError` redige segredos conhecidos, e-mail, host/IP, credenciais e valor monetário
  antes de gravar em `last_error` (`bill-reminders.ts:195-222`); `last_error` e logs do ciclo não
  carregam valor/credencial/PII no caminho de envio.
- E-mail sem valor monetário por construção: `ReminderItemView` não possui `amountCents`
  (`bill-reminder-email.ts:36-45`).
- TLS obrigatório no SMTP: `STARTTLS` exigido na 587, TLS implícito na 465, mínimo TLS 1.2
  (`bill-reminder-smtp.ts:141-153`).
- Transporte real só sobe com `BILL_REMINDER_TRANSPORT=smtp` + credenciais completas; padrão
  `dry-run` (nenhum envio real, agendador não sobe) (`index.ts:28-32`, `config.ts`).
- `start()` do agendador não bloqueia a API; catch-up em segundo plano (`bill-reminder-scheduler.ts:109-120`).
- Nenhuma dependência nova, nenhuma variável de ambiente nova, nenhum endpoint HTTP novo e nenhuma
  migração/schema alterado nesta correção (confirmado por inspeção).
- Servidor escuta em `127.0.0.1` por padrão (`index.ts:13`); backups/DB em diretórios ignorados pelo git.
- Nenhum teste abre rede (fetch bloqueado nos testes da CLI; nodemailer substituído por dublê).

### Não verificado

- Execução real da suíte (shell indisponível na sessão); testes referenciados como verdes no
  `qa/evidence/bill-reminders.md` (362 testes).
- Rede/WAF/sistema de arquivos do host fora do repositório.

## Veredito da rodada de regressão (2026-10-22)

**SEM REGRESSÃO** — build verde, 362/362 testes passando, sem flakes observados.

### Ambiente
- Branch / commit: `feat/bill-reminders-email` @ `5f38d3c`
- Baseline comparado: ciclo anterior 357 testes (331 server + 26 client), sem arquivo de baseline gravado anteriormente
- Suíte: Vitest 3.2.7 · Node v24.21.0

### Resultado

| Métrica | Baseline | Agora | Δ |
|---|---|---|---|
| testes | 357 | 362 | +5 |
| passou | 357 | 362 | +5 |
| falhou | 0 | 0 | 0 |
| skip | 0 | 0 | 0 |
| duração | n/a | 39.99s (server 35.59s + client 4.40s) | n/a |

### Regressões (PASSOU → FALHOU)
- Nenhuma.

### Skips novos (regressão silenciosa)
- Nenhum.

### Falhas pré-existentes (não bloqueiam)
- Nenhuma.

### Flakies
| Teste | Falhas | Taxa | Evidência |
|---|---|---|---|
| `bill-reminder-concurrency.test.ts` | 0/3 | 0% | 3 execuções isoladas, 4/4 |
| `bill-reminders.test.ts` | 0/3 | 0% | 3 execuções isoladas, 68/68 |
| `bill-reminder-cli.test.ts` | 0/3 | 0% | 3 execuções isoladas, 14/14 |
| suíte completa | 0/2 | 0% | 336/336 server + 26/26 client em ambas |

### Cobertura da execução
- Unit/integration server: 22/22 arquivos, 336/336 testes.
- Client: 2/2 arquivos, 26/26 testes.
- E2E: não configurado no repositório (nenhum spec pulado por este agente).

### Arquivos de teste alterados
- `server/tests/bill-reminders.test.ts`: +1 teste (start não bloqueante); `whenIdle()` adicionado em 2 cenários existentes (sem perda de cobertura).
- `server/tests/bill-reminder-cli.test.ts`: 1 teste repurposado (mensagem obsoleta → claim atômico); contagem mantida (14).
- `server/tests/bill-reminder-concurrency.test.ts`: novo, 4 testes de concorrência em banco temporário.
- Nenhum teste pré-existente removido; contagem de `it()` em `bill-reminders` passou de 67 para 68 e em CLI manteve 14.

### Verificações de segurança/escopo
- `git diff --check`: limpo (apenas warning de CRLF em README.md).
- `git status --short`: apenas os arquivos esperados (8 modificados + 1 não rastreado novo teste).
- Banco real, backups, `.env`, `dist` e logs não aparecem no status (ignorados); novos testes não tocam `server/data/finance.db` (usam diretórios temporários) e não abrem rede nem enviam e-mail real (SMTP falso/inválido).
- Sem `.only`/`.skip`/`console.log`/`debugger` nos testes de lembretes.

### Baseline atualizado
- `qa/baseline/run-2026-10-22.json` gravado.

### Achados menores tratados após as auditorias

- `server/src/db/client.ts`: `busy_timeout = 5000` explícito. O default do
  better-sqlite3 já é 5 s; agora não depende do default do driver no caminho
  CLI × backend.
- `bill-reminder-scheduler.ts`: erro inesperado do ciclo passa por
  `sanitizeReminderError` antes de ir para o log (mesma redação do caminho de
  envio).
- `bill-reminders.ts`: atualização final de lote + notificações em uma única
  transação, tanto no sucesso quanto na falha; um crash no meio não deixa
  lote `sent`/`failed` com notificação em estado divergente.
- Deliberadamente não alterados: espera do ciclo em voo no shutdown (pode
  atrasar o SIGTERM por até o timeout do SMTP; a retomada de `pending` cobre
  o caso), redação de descrições com menos de 4 caracteres (evita mutilar a
  mensagem de erro) e restrição de `--today` (CLI local, mesma confiança do
  operador).
