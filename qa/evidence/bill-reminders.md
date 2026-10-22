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
5. Envio agrupado por (marco, data-alvo) → **1 e-mail por marco/dia**. Lote já `sent` → marca `skipped`.
6. Resumo com contagens, sem PII.

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
