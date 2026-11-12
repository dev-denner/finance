# Finance

Aplicação web local para substituir a planilha de controle financeiro: importa lançamentos de CSV/Excel, permite editar em massa e gera o consolidado anual por categoria.

Tudo roda na sua máquina. Não há login, cloud, integração bancária, Docker ou serviço pago.

## Recursos

- **Importação** de CSV, XLS e XLSX com prévia, mapeamento manual de colunas, correção/rejeição de linhas, criação automática de categorias e formas de pagamento e detecção de duplicidades.
- **Importações**: área central com os fluxos **Importar movimentações** e **Importar NFC-e/compras** (uma nota pelo QR Code ou lote em CSV/TXT), além do histórico unificado por tipo, data, quantidade processada e resultado.
- **Transferências entre contas** detectadas na importação (valor de mesmo módulo, sinais opostos, contas diferentes e datas próximas), com revisão lado a lado antes de confirmar, vínculo persistente, desvínculo manual e indicador visual na listagem.
- **Lançamentos** em formato de planilha: filtros por ano/mês, categoria, pagamento e texto; ordenação (inclusive por **Categoria** e **Pagamento**, A–Z/Z–A); paginação; criação, edição inline e exclusão.
- **Edição em massa** de categoria, forma de pagamento e exclusão, mantendo a seleção entre páginas e filtros.
- **Consolidado anual** por categoria, com 12 colunas mensais, total, média e totais gerais, além da cor de cada categoria. Clique em uma célula para ver os lançamentos que a compõem.
- **Cadastros auxiliares** de categorias e formas de pagamento, com renomeação, **cor opcional por categoria** e exclusão com reatribuição.
- **Lembretes por e-mail** das contas a pagar que ainda não foram agendadas, com avisos nos marcos D-3, D-2, D-1 e D0.
- **Compras**: lista com busca por fornecedor/nota, detalhes dos itens e atalho para importar uma nova NFC-e pela área de Importações; separada das movimentações financeiras.
- **Tema claro/escuro**, valores em BRL, datas `DD/MM/AAAA` e layout desktop-first.
- **SQLite persistente** com migrações versionadas e backup por linha de comando.

## Stack

| Camada   | Tecnologia                                              |
| -------- | ------------------------------------------------------- |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS, React Router  |
| Backend  | Node.js, TypeScript, Fastify                            |
| Banco    | SQLite (`better-sqlite3`) + Drizzle ORM                 |
| Planilhas| SheetJS (`xlsx`)                                        |
| Testes   | Vitest                                                  |

## Estrutura

```
finance/
├── client/                  # SPA React
│   ├── src/
│   │   ├── components/      # Layout, sidebar e componentes de UI
│   │   ├── context/         # Tema, avisos, cadastros e seleção
│   │   ├── lib/             # Cliente HTTP, tipos e formatadores
│   │   └── pages/           # Movimentações, Consolidado, Importações, Compras, Cadastros
│   └── dist/                # Build servido pelo backend em produção
├── server/
│   ├── drizzle/             # Migrações SQL geradas e journal
│   ├── src/
│   │   ├── db/              # Schema, conexão, migrações e backup
│   │   ├── lib/             # Moeda, datas, normalização e parcelas
│   │   ├── routes/          # Endpoints Fastify
│   │   └── services/        # Regras de negócio
│   ├── tests/               # Testes Vitest
│   └── data/                # Banco local (criado em tempo de execução)
├── sample-finance.csv       # Arquivo de exemplo para testar a importação
└── package.json             # Scripts do monorepo (npm workspaces)
```

O fluxo é sempre `rota → serviço → Drizzle/SQLite`. O frontend consome apenas `/api`.

## Requisitos

- Node.js 20 ou superior (testado com Node 24).
- npm.
- No Windows/PowerShell, use `npm.cmd` em vez de `npm` caso o PowerShell bloqueie `npm.ps1`.

## Instalação

Na raiz do projeto:

```powershell
npm.cmd install
```

O `better-sqlite3` é um módulo nativo. Se a instalação for bloqueada por política de scripts do npm:

```powershell
npm.cmd install-scripts approve better-sqlite3 esbuild
npm.cmd rebuild better-sqlite3
```

## Executar em desenvolvimento

```powershell
npm.cmd run dev
```

- Aplicação: <http://localhost:5173>
- API: <http://127.0.0.1:3001>
- O Vite faz proxy de `/api` para o backend.

Na primeira execução o banco `server/data/finance.db` é criado e as migrações são aplicadas automaticamente.

Para testar o fluxo completo, importe `sample-finance.csv` pela tela **Importações** (5 lançamentos em janeiro de 2026).

## Executar em produção

```powershell
npm.cmd run build
npm.cmd start
```

Acesse <http://127.0.0.1:3001>. Nesse modo o Fastify serve o build do frontend e a API no mesmo endereço.

## Configuração

Variáveis opcionais de ambiente:

| Variável        | Padrão                              | Descrição                              |
| --------------- | ----------------------------------- | -------------------------------------- |
| `PORT`          | `3001`                              | Porta HTTP do backend                  |
| `HOST`          | `127.0.0.1`                         | Interface de escuta                    |
| `DATABASE_PATH` | `server/data/finance.db`            | Caminho do arquivo SQLite              |
| `BACKUP_DIR`    | `server/backups`                    | Destino dos backups gerados pelo CLI   |

Exemplo no PowerShell:

```powershell
$env:DATABASE_PATH = "D:\financeiro\meu-finance.db"
$env:PORT = "4000"
npm.cmd run dev
```

### Variáveis dos lembretes por e-mail

Recurso opcional: **sem `BILL_REMINDER_TO` nada é enviado** e o aplicativo
funciona normalmente. O transporte padrão é `dry-run` — nenhum e-mail real sai
da máquina, **o agendador nem sobe** e o aviso do dia **não é consumido**
(os lembretes ficam em modo de pré-visualização).

Os comandos do servidor carregam automaticamente o arquivo local `.env` na raiz
do projeto, quando ele existir. Esse arquivo é ignorado pelo Git e deve guardar
apenas configurações locais, como destinatário e credenciais SMTP; nunca o
commite. Para ativar a pré-visualização dos lembretes, crie `.env` com
`BILL_REMINDER_TO=seu-email@exemplo.com`.

| Variável                        | Padrão             | Quando é obrigatória                                                                             | Descrição                                              |
| ------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `BILL_REMINDER_TRANSPORT`       | `dry-run`          | —                                                                                                | `dry-run` (não envia) ou `smtp` (envia de verdade)      |
| `BILL_REMINDER_TO`              | —                  | **Sempre** para o recurso existir                                                                | Destinatário dos avisos                                |
| `BILL_REMINDER_FROM`            | `finance@localhost`| —                                                                                                | Remetente dos avisos                                    |
| `BILL_REMINDER_SMTP_HOST`       | —                  | Com `BILL_REMINDER_TRANSPORT=smtp`                                                               | Servidor SMTP                                           |
| `BILL_REMINDER_SMTP_PORT`       | `587`              | —                                                                                                | Porta do servidor SMTP (587 = STARTTLS, 465 = TLS implícito) |
| `BILL_REMINDER_SMTP_SECURE`     | `false`            | —                                                                                                | TLS direto na conexão (`true/false`, `1/0`, `yes/no`)   |
| `BILL_REMINDER_SMTP_USER`       | —                  | Com `BILL_REMINDER_TRANSPORT=smtp`                                                               | Usuário do SMTP                                         |
| `BILL_REMINDER_SMTP_PASSWORD`   | —                  | Com `BILL_REMINDER_TRANSPORT=smtp`                                                               | Senha do SMTP                                           |
| `BILL_REMINDER_CATCH_UP_DAYS`   | `3`                | —                                                                                                | Janela de recuperação de marcos perdidos (dias)         |
| `BILL_REMINDER_INTERVAL_MINUTES`| `30`               | —                                                                                                | Intervalo do agendador interno (minutos)                |

O fuso usado para calcular "hoje" é **America/Sao_Paulo** e está fixo no código —
não é variável de ambiente. Nenhuma dessas variáveis é lida em outro lugar do
aplicativo.

**TLS é obrigatório.** Com o transporte `smtp`:

- na porta **587** (padrão) o `STARTTLS` é **exigido**: se o servidor não
  anunciar TLS, a conexão é abortada e nada é enviado em texto claro;
- na porta **465** o TLS é **implícito** (a porta sozinha já ativa a conexão
  criptografada, mesmo com `BILL_REMINDER_SMTP_SECURE` ausente);
- a versão mínima aceita é **TLS 1.2**.

Exemplo (PowerShell) para ligar o envio real:

```powershell
$env:BILL_REMINDER_TRANSPORT = "smtp"
$env:BILL_REMINDER_TO = "voce@exemplo.com"
$env:BILL_REMINDER_SMTP_HOST = "smtp.exemplo.com"
$env:BILL_REMINDER_SMTP_PORT = "587"
$env:BILL_REMINDER_SMTP_USER = "finance"
$env:BILL_REMINDER_SMTP_PASSWORD = "segredo"
npm.cmd start
```

## Lembretes por e-mail

Contas a pagar com situação **pendente** (ainda não agendadas) recebem um
aviso por e-mail nos marcos **D-3, D-2, D-1 e D0** — isto é, 3, 2, 1 e 0 dias
antes do vencimento.

- **Um aviso por marco e dia**: todos os itens elegíveis do mesmo marco são
  consolidados em **um único e-mail**.
- **No máximo 4 avisos por conta e vencimento**: cada marco dispara uma vez
  só. **Corrigir o vencimento** da conta cria um **conjunto novo de marcos** —
  o histórico do vencimento anterior não é reaproveitado e um marco já
  avisado pode ser avisado de novo (até 4 avisos por conta **e vencimento**).
- **Marcar como agendado (`AG`) ou pagar (`PG`) interrompe** os avisos
  restantes da conta.
- **Sem valor no e-mail**: o aviso traz apenas descrição, vencimento
  (`DD/MM/AAAA`), prazo restante (`faltam 3 dias`), categoria, quantidade de
  itens e o marco. Nenhum valor monetário, total ou soma é enviado — a
  garantia é estrutural, o tipo usado pelo renderizador nem possui o campo de
  valor.
- **A descrição da conta vai no e-mail**: ela é texto livre e pode conter dado
  pessoal. Evite colocar nome de pessoa, documento ou qualquer outra
  informação sensível na descrição da conta a pagar.
- O e-mail deixa explícito que **os itens precisam ser agendados** e lembra que
  o aviso acontece no máximo uma vez por marco.
- `Message-ID` determinístico por marco e data (`<bill-reminder-D-3-2026-10-22@finance.local>`),
  para o cliente de e-mail deduplicar avisos repetidos.
- **Falha persistente tem limite**: cada aviso é tentado no máximo **5 vezes**.
  Depois disso ele é descartado (`skipped`, motivo `falha persistente: limite
  de tentativas`) e o registro fica no histórico — a falha não vira retentativa
  eterna.
- **Motivos no histórico**: todo descarte fica auditável em `last_error`
  (`marco perdido: coberto pelo aviso de hoje`, `conta não está mais pendente`,
  `vencimento alterado`, `data-alvo fora da janela`, entre outros). As mensagens
  de erro do servidor de e-mail são sanitizadas: e-mail, host, usuário, senha,
  valor e texto da conta **não** são gravados.

### Execução

O agendador interno roda junto com o backend (a cada 30 minutos por padrão) e
faz um *catch-up* **em segundo plano** na subida — o envio de e-mail nunca
atrasa a API. "Hoje" é recalculado em São Paulo a cada ciclo.

**O agendador só sobe com transporte que entrega de verdade** (`smtp`). Com
`BILL_REMINDER_TRANSPORT=dry-run` o servidor **não** agenda nada: os lembretes
ficam em modo de pré-visualização e nenhum aviso é consumido.

Para rodar um ciclo sob demanda, sem depender do agendador:

```powershell
npm.cmd run reminders:run
npm.cmd run reminders:run -- --today=2026-10-21
npm.cmd run reminders:run -- --today=21/10/2026
npm.cmd run reminders:run -- --dry-run
```



- `--today=AAAA-MM-DD` (ou `DD/MM/AAAA`) fixa a data de referência do ciclo.
- `--dry-run` **simula** o ciclo: imprime o e-mail em vez de enviá-lo e
  **não grava nada no banco** (nenhum lote, nenhuma notificação). Por isso o
  `--dry-run` **não consome o aviso** — o marco continua elegível e sai no
  ciclo seguinte com o transporte que envia.
- **A CLI pode rodar junto com o backend**: o lote de cada marco é reservado
  de forma atômica no banco, então só um processo envia aquele e-mail. Em
  condições normais não há aviso duplicado. A garantia é **at-least-once**: se
  um processo cair **depois** de o servidor SMTP aceitar a mensagem e **antes**
  de gravar o estado `sent`, o marco pode ser reenviado no ciclo seguinte — não
  é "exactly once". O `Message-ID` determinístico ajuda o cliente de e-mail a
  deduplicar.

O mesmo núcleo (`runBillReminders`) atende o agendador e a linha de comando, e o
`Message-ID` evita duplicidade quando o aviso é reenviado.

## Compras e NFC-e de RJ, SP e TO

A tela **Importações** concentra os dois fluxos: **Importar movimentações** (planilhas
CSV/Excel) e **Importar NFC-e/compras**. A tela também aceita PDFs textuais de NFC-e do RJ e do MG (no MG, a seção da chave de acesso precisa estar expandida). Ao importar uma NFC-e pela URL, a tela consulta o
portal oficial do estado detectado (RJ, SP ou TO) a partir da URL do QR Code, mostra
uma prévia identificada pela UF e só persiste depois da confirmação. A tela **Compras** organiza as notas por ano e mês, mostra data, fornecedor, número de itens, pagamento, total e categoria, com filtros e resumo do período. A categoria é uma classificação local opcional; ela não altera os dados fiscais importados nem cria movimentações. Nos detalhes, é possível classificar cada item individualmente ou selecionar vários itens; também dá para criar uma categoria ali mesmo, com cor opcional, e aplicá-la imediatamente à seleção. Essa classificação é independente da categoria geral da compra e não altera os dados fiscais. O atalho **Importar NFC-e** leva ao fluxo central sem duplicar o formulário. Compras e itens ficam em tabelas
próprias, com deduplicação pela chave de acesso; nenhuma movimentação financeira
é criada ou alterada durante a importação. Nos detalhes da compra, a conciliação
oferece movimentações de saída de valor e data próximos (até 7 dias antes ou
depois da emissão); pagamentos parciais podem ser combinados para fechar o total.
A pessoa revisa e confirma os vínculos; então a categoria escolhida é aplicada
à compra e a todos os seus itens, sem alterar as movimentações. É possível
desfazer a conciliação para restaurar as categorias anteriores. Uma compra pode
ser liquidada por várias movimentações e carteiras;
cada parcela é revisada e o total precisa fechar exatamente antes da confirmação.
Uma movimentação só pode aparecer em uma liquidação ativa. A categoria aplicada
é escolhida explicitamente e as movimentações originais não são modificadas.
O desfazer marca os vínculos como revertidos, restaura as categorias anteriores
e preserva ajustes de saldo auditáveis.

Contas e meios de pagamento têm classificação explícita: crédito, débito,
carteira ou não classificada. A migração inicial classifica nomes existentes
com prefixo `CC` como crédito e `CD` como débito; esse prefixo não define contas
criadas posteriormente. Crédito pode ficar negativo. Débito e carteiras precisam
manter saldo cronológico não negativo. Carteiras podem receber créditos iniciais,
cashback ou bônus como ajustes auditáveis com vigência retroativa, sem criar
movimentações financeiras fictícias. Se o saldo faltar durante a conciliação,
o Finance mostra a insuficiência e exige confirmação do ajuste; o ajuste e os
vínculos são gravados atomicamente. Importar a nota continua independente de
saldo e não cria ou altera movimentações.

No portal do RJ, redirecionamentos HTTP do host oficial para o próprio host são
atualizados para HTTPS antes da navegação; destinos externos ou outros hosts não
são aceitos.

Além da nota única, a mesma tela importa várias NFC-e por arquivo **CSV** ou
**TXT**: uma URL de QR Code por linha ou numa coluna escolhida, com detecção de
cabeçalho e arquivos sem cabeçalho. A prévia mostra, por linha, situação,
fornecedor, identificação da nota, itens e total; linhas vazias, URLs inválidas,
notas repetidas no próprio arquivo e notas já existentes aparecem identificadas
e nunca são descartadas em silêncio. Só as linhas confirmadas são importadas,
cada nota é persistida de forma atômica e deduplicada pela chave de acesso, e
notas já existentes não são reconsultadas no portal. Uma falha em uma nota não
impede as demais. Cada linha física do arquivo é uma linha do lote; células com
quebra de linha entre aspas não são suportadas. Limites do lote: 1 MB, 200
linhas, 50 consultas por lote e 2048 caracteres por linha — arquivos maiores
devem ser divididos em partes.

Também é possível colar o texto copiado de uma ou várias páginas da NFC-e ou
carregar um arquivo TXT. Separe cada nota com uma linha contendo três ou mais
hífens. A prévia valida fornecedor, chave de acesso, identificação, itens e
totais; blocos incompletos ou incompatíveis ficam destacados para conferência.
Esse fluxo não abre navegador nem consulta a SEFAZ, não salva o texto bruto e
não importa CPF ou dados de pagamento do consumidor. Limite: 1 MB e até 50
notas por envio. A importação HTML salvo será adicionada em uma etapa posterior.

Se um portal informar bloqueio de acesso, a consulta individual mostra uma
mensagem específica e o lote é interrompido na primeira ocorrência. As linhas
restantes são marcadas como não consultadas; o Finance não tenta novamente nem
contorna o bloqueio. Após o aviso explícito de bloqueio por reputação da
SEFAZ-RJ, consultas RJ ficam pausadas localmente por 72 horas; novas prévias e
importações são recusadas nesse período, e SP/TO continuam independentes.

Para proteger os portais, o Finance inicia no máximo 10 consultas por estado em
qualquer janela móvel de 24 horas e exige pelo menos 30 segundos entre consultas
ao mesmo estado. Tentativas são contabilizadas antes de abrir o navegador,
inclusive quando o portal falha. Ao atingir um limite num lote, as linhas
restantes são marcadas como não consultadas. O estado mínimo desses controles
(UF, horários de tentativa e prazo da pausa RJ) é salvo atomicamente em
`server/data/nfce-query-guard.json`, com permissões locais restritas; se não for
possível ler ou gravar esse arquivo, novas consultas são bloqueadas.

O backend usa Playwright para abrir uma janela normal do Google Chrome ou
Chromium instalado no computador. A consulta tem limite de tempo, tamanho e
requisições, valida os endereços DNS públicos e fixa o endereço resolvido durante
a navegação. No RJ são permitidos os hosts e o script já usados pelo adaptador
estadual. Em SP, somente `www.nfce.fazenda.sp.gov.br` é permitido e o documento
pode redirecionar de `/qrcode` para `/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx`
no mesmo host. Outros hosts, protocolos, caminhos de navegação e destinos de
redirecionamento são bloqueados. Não há uso de stealth, proxy, rotação de IP ou
resolução de CAPTCHA. O navegador fecha após obter a prévia.

São armazenados fornecedor, CNPJ do fornecedor, identificação/data da NFC-e,
chave de acesso, total a pagar, desconto geral da nota quando informado, forma
de pagamento quando disponível e os itens. A soma dos itens é conferida com o
valor total bruto; o desconto geral é conferido contra o valor líquido a pagar. CPF do
consumidor, dados de cartão, autorização, URL completa do QR Code e HTML bruto
nunca são armazenados. Os adaptadores RJ e SP mantêm a extração dos portais
separada do modelo interno; o adaptador SP aceita QR Code online v2 e confere a
UF, modelo e dígito verificador da chave. Se os campos obrigatórios não forem
encontrados ou os itens, desconto e total a pagar não fecharem, a importação é
recusada para revisão, sem salvar parcialmente. Campos opcionais ausentes, como
forma de pagamento ou desconto por item, permanecem sem valor.

**Limitação conhecida:** os parsers dependem dos layouts atuais dos portais de
RJ e SP. O parser valida os dados normalizados e recusa a importação quando a
relação entre itens, desconto e total a pagar não confere. MG permanece fora do
suporte desta etapa.

## Importação

Formatos aceitos: `.csv`, `.txt`, `.xls`, `.xlsx` e `.xlsm` (primeira planilha do arquivo, até 20.000 linhas e 25 MB).

1. Em **Importações**, escolha **Importar movimentações** e arraste o arquivo ou clique para selecionar.
2. Confira o mapeamento das colunas. Obrigatórias: **Compra** (ou **Lançamento**) e **Valor**. **Data Compra** e **Vencimento** são opcionais, mas a linha precisa de pelo menos uma data válida.
3. Se alguma linha ficar sem conta/pagamento (arquivo sem a coluna ou célula vazia), escolha a **conta de destino do lote** antes de confirmar.
4. Revise a prévia. Linhas com erro podem ser corrigidas ou rejeitadas individualmente.
5. Se houver pares candidatos de transferência, revise cada par lado a lado e escolha **Confirmar**, **Rejeitar** ou **Pendente**.
6. Revise as **sugestões de categoria** agrupadas por categoria de origem.
7. Escolha o tratamento de duplicidades e confirme a importação.

### Datas: informadas e estimadas

- Datas aceitas como `DD/MM/AAAA`, `AAAA-MM-DD` e datas nativas do Excel.
- **Vencimento informado** no arquivo sempre tem prioridade e é preservado.
- Sem vencimento, mas com **data de compra** e **parcela atual** válidas, o vencimento é calculado:
  `vencimento_estimado = data_compra + (parcela_atual - 1) meses`.
- Sem qualquer informação de parcelamento, o vencimento assumido é a própria data de compra, com origem própria `derived_from_purchase_fallback` (badge **sem parcela**). Não é apresentado como cálculo de parcela.
- A aritmética usa calendário civil: `31/01 + 1 mês` vira `29/02` em ano bissexto e `28/02` nos demais; não há deslocamento de fuso horário.
- `Compra à vista` é reconhecida como compra sem parcelamento e usa a própria data de compra como vencimento.
- Se não houver nenhuma data válida, a linha fica bloqueada até a correção. Se houver data inválida, o erro é corrigível na prévia.
- A prévia mostra **estimado**, **à vista** ou **sem parcela** ao lado do vencimento calculado. O lançamento guarda a origem da data (`file`, `estimated_from_installment`, `derived_from_cash_purchase` ou `derived_from_purchase_fallback`).
- Quando o vencimento vem do arquivo, o Addendo 3 continua estimando a primeira parcela:
  `primeira_parcela_estimada = vencimento - (parcela_atual - 1) meses`. Quando o vencimento foi derivado da compra, essa estimativa não é tratada como uma segunda evidência independente.
- **Limitação:** a data calculada é uma convenção de importação definida pelo usuário. Ela não confirma o vencimento bancário real do cartão.

### Parcelas

- Formatos reconhecidos: `Parcela 1/10`, `Parcela 5/12`, `Parcela 01/06`, `1/10`, `01/10`, `Parcela 3 de 12` e variações de caixa, acento e espaço.
- `Compra à vista` (e variações isoladas como `avista`/`vista`) significa compra sem parcelamento, não erro. A expressão precisa estar isolada na célula/descrição; nomes de estabelecimento como `Loja Vista` não são tratados como compra à vista.
- O texto original da parcela é preservado para auditoria. Seriais de data do Excel não são interpretados como número de parcela.
- Quando a coluna de parcelas não existe, a recuperação pela descrição continua disponível.

### Conta de destino

- Se o arquivo tiver coluna de conta/cartão/pagamento, os valores informados são preservados linha a linha e a conta de destino cobre apenas as linhas vazias.
- Sem essa coluna, a conta escolhida para o lote é usada apenas nas linhas sem conta. A importação fica bloqueada enquanto não houver uma conta válida — nenhuma conta padrão é inventada.
- Valores positivos e negativos são preservados exatamente como no arquivo; o importador não inverte sinais automaticamente.

### Sugestões e aliases de categoria

Antes de criar uma categoria, o importador procura uma existente em camadas: correspondência exata, normalização (caixa/acentos/espaços/pontuação), alias aprendido, similaridade textual e contexto (descrição + categoria de origem). A sugestão é local e determinística, sem serviços externos ou embeddings.

- A prévia mostra a categoria de origem, a sugestão, o nível de confiança (**alta**, **média**, **baixa**) e o motivo.
- Para cada grupo de origem é possível **usar a sugerida**, **escolher outra categoria existente** ou **criar uma nova**. A decisão vale para todas as linhas do grupo.
- Sugestões ambíguas ou de baixa confiança nunca são aplicadas sozinhas.
- Aliases permanentes só são criados após **confirmação explícita da equivalência** na revisão (escolher a sugerida ou outra categoria existente). Sugestões automáticas, inclusive as contextuais, não geram alias sem essa confirmação; sugestões rejeitadas ou de grupos ambíguos também não. Se a categoria de destino for excluída com reatribuição, o alias acompanha o novo destino.
- **Pagamento de cartão:** uma linha como `Pagamento Fatura` com categoria `PAGAMENTO_RECEBIDO` pode receber a sugestão contextual `Pagamento de cartão`. O valor e o sinal não são alterados, a linha não vira receita operacional e a sugestão, sozinha, não concilia transferências nem remove o lançamento do consolidado.

### Demais regras

- Valores como `-R$ 500,00`, `R$ 1.250,50` e `-R$ 500.00` são aceitos conforme o formato detectado. Formatos ambíguos, como `1,250`, são rejeitados em vez de adivinhados.
- Categorias e formas de pagamento inexistentes são criadas automaticamente, preservando o nome original de exibição e ignorando diferenças de caixa, acentos e espaços redundantes.
- A duplicidade é detectada por uma impressão digital dos campos do lançamento, incluindo a conta de destino e a categoria resolvida. Assim, reimportar o mesmo arquivo com as mesmas decisões é idempotente. Por padrão, duplicidades são ignoradas; desmarque a opção para importá-las mesmo assim.
- A importação inteira roda em uma transação do SQLite. O arquivo original não é armazenado nem alterado.
- Cada importação de movimentações gera um registro com total, importados e rejeitados. O histórico central de **Importações** combina esses lotes com cada compra importada, identificando tipo, data, quantidade processada e resultado. Não há tabela nova de histórico de compras: cada compra persistida já é o próprio registro da importação.

Também é possível criar lançamentos manualmente em **Movimentações**.

## Transferências entre contas

Transferências internas movimentam dinheiro entre contas próprias e **não** são receita nem despesa. O aplicativo as trata como um vínculo persistente entre dois lançamentos: uma saída (valor negativo) e uma entrada (valor positivo) de mesmo módulo, em contas diferentes.

**Detecção na importação**

- Um par candidato exige valor absoluto igual, sinais opostos, contas diferentes e datas dentro da tolerância (padrão de 3 dias, configurável).
- A confiança sobe para **alta** quando há evidência adicional: coluna `Transf` marcada nos dois lançamentos, descrição indicando transferência/PIX/TED, ou data idêntica com a coluna marcada.
- Igualdade de valor, sinal e data **não** é prova suficiente: sem evidência adicional o par fica como **possível**.
- Quando um mesmo lançamento tem mais de um par candidato, todos ficam marcados como **ambíguos** e como possibilidade, sem confirmação automática.
- Pares entre dois lançamentos já gravados não são vinculados automaticamente; eles aparecem no vínculo manual.

**Revisão antes de importar**

- Cada par candidato é mostrado lado a lado com data, descrição, valor, conta de origem, conta de destino, motivo e nível de confiança.
- O usuário pode **Confirmar**, **Rejeitar** ou deixar **Pendente**. Pares de alta confiança e sem ambiguidade já vêm confirmados, mas continuam revisáveis.
- Confirmar um par desmarca automaticamente candidatos conflitantes que compartilhem a mesma ponta.
- Se não houver candidatos, a importação segue o fluxo normal.

**Visualização e vínculo manual**

- A coluna **Transf** mostra “Enviada”/“Recebida” para transferências confirmadas e “Transferência?” para lançamentos marcados no arquivo mas ainda sem par confirmado.
- Clique na coluna para ver o lançamento correspondente e as contas envolvidas, ou para procurar um par e vincular manualmente.
- É possível desvincular a qualquer momento. A marcação original do arquivo é preservada como evidência.

**Integridade**

- Cada lançamento participa de no máximo uma transferência ativa (garantido por índices únicos e gatilhos no banco).
- Excluir ou alterar valor/sinal/conta de um lançamento vinculado é bloqueado com mensagem explícita: desvincule antes.
- Trocar a forma de pagamento em massa é bloqueado se isso deixaria as duas pontas na mesma conta.
- Transferências confirmadas ficam fora de receitas e despesas (listagem, resumo e consolidado) e continuam visíveis na visão individual e no filtro **Transferências**.

## Cores das categorias

- Cada categoria pode ter uma cor opcional no formato `#RRGGBB`, definida em **Cadastros**.
- Categorias sem cor recebem automaticamente uma cor padrão estável, garantindo distinção visual.
- As cores aparecem num filete e num marcador discreto no **Consolidado** e em seletores/indicadores relacionados, com bom contraste nos temas claro e escuro.
- A cor é apenas visual: não altera valores, totais nem médias.

## Regras de negócio

- **Dinheiro** é sempre inteiro em centavos (`amount_cents`), com sinal. Nenhum valor monetário é armazenado como ponto flutuante.
- **Datas** são armazenadas em ISO (`AAAA-MM-DD`) e exibidas em `DD/MM/AAAA`.
- **Mês de referência** usa o vencimento por padrão; a tela permite alternar para a data da compra.
- **Consolidado**:
  - despesas: lançamentos negativos sem transferência textual e sem vínculo de transferência confirmado, exibidos como valores positivos;
  - receitas: lançamentos positivos sem transferência textual e sem vínculo confirmado;
  - transferências: lançamentos marcados no arquivo como transferência ou vinculados a uma transferência confirmada, isolados das demais visões;
  - a média considera apenas os meses com movimento na categoria, mesmo que o líquido do mês seja zero;
  - meses sem movimento aparecem como zero;
  - o relatório é calculado diretamente dos lançamentos, sem tabela de resumo.
- **Seleção em massa** é mantida ao navegar entre páginas e ao mudar filtros. A barra de ações mostra a quantidade total selecionada, inclusive itens fora da página atual.
- **Categorias e formas de pagamento** não podem ser excluídas deixando referências inválidas. A tela oferece reatribuição dos lançamentos para outro cadastro. Reatribuir a forma de pagamento é bloqueado se quebrar uma transferência confirmada.

## Scripts

| Comando                  | Efeito                                                    |
| ------------------------ | --------------------------------------------------------- |
| `npm.cmd run dev`        | Backend + frontend em modo desenvolvimento                |
| `npm.cmd run build`      | Compila backend e gera o build do frontend                |
| `npm.cmd start`          | Sobe o backend servindo o build de produção               |
| `npm.cmd test`           | Executa a suíte de testes uma vez                         |
| `npm.cmd run test:watch` | Executa os testes em watch mode                           |
| `npm.cmd run db:generate`| Gera uma nova migração a partir do schema                 |
| `npm.cmd run db:migrate` | Aplica migrações manualmente                              |
| `npm.cmd run db:backup`  | Cria um backup consistente do SQLite                      |
| `npm.cmd run db:reset:data` | Reset de movimentações (preserva categorias e pagamentos) |
| `npm.cmd run db:reset:all`  | Reset completo (inclui categorias e pagamentos)           |
| `npm.cmd run db:restore`    | Restaura um backup interativamente                        |
| `npm.cmd run db:studio`  | Abre o Drizzle Studio para inspecionar o banco            |
| `npm.cmd run reminders:run` | Executa um ciclo de lembretes por e-mail (use `-- --dry-run` para simular sem enviar e sem gravar) |

## Banco de dados e migrações

- Schema: `server/src/db/schema.ts`.
- Migrações SQL: `server/drizzle/`.
- Banco padrão: `server/data/finance.db` (modo WAL, `foreign_keys = ON`).

As migrações são aplicadas automaticamente ao iniciar o backend. Ao alterar o schema:

```powershell
npm.cmd run db:generate
npm.cmd run db:migrate
```

Tabelas:

- `categories` e `payment_methods`: nome de exibição + nome normalizado com unicidade; categorias têm `color` opcional.
- `transactions`: lançamentos com FKs para categoria, pagamento e lote de importação. A coluna `transfer` preserva a marcação original do arquivo.
- `import_batches`: histórico das importações.
- `transfers`: vínculo entre uma saída e uma entrada (`outgoing_transaction_id`, `incoming_transaction_id`), com confiança e origem. Índices únicos e gatilhos impedem que um lançamento participe de duas transferências ou que o par tenha contas/valores inválidos.
- `bill_reminder_batches`: um registro por e-mail de lembrete, com chave única `(milestone, send_date)` — no máximo um e-mail por marco e dia.
- `bill_reminder_notifications`: histórico por conta e marco, com chave única `(bill_id, milestone, due_date)`. Apagar a conta apaga o histórico dela (`ON DELETE CASCADE`).

Antes de aplicar uma migração que altere dados, gere um backup com `npm.cmd run db:backup`. As migrações nunca apagam lançamentos existentes.

## Backup e restauração

### Backup pela aplicação

```powershell
npm.cmd run db:backup
```

O comando usa `VACUUM INTO` e gera um arquivo consistente em `server/backups/finance-<data>.db`, mesmo com o aplicativo aberto.

Para escolher outro destino:

```powershell
$env:BACKUP_DIR = "D:\backups\finance"
npm.cmd run db:backup
```

### Reset do banco de dados

Para testes repetidos de importação, duplicidades, parcelas, transferências e consolidação, há dois modos oficiais de reset:

```powershell
# Reset de movimentações: apaga lançamentos, lotes de importação,
# vínculos de transferência, rejeições de conciliação e o histórico
# dos lembretes por e-mail.
# Preserva categorias e formas de pagamento cadastradas.
npm.cmd run db:reset:data

# Reset completo: também apaga categorias e formas de pagamento.
npm.cmd run db:reset:all
```

O escopo do reset inclui `bill_reminder_notifications` e
`bill_reminder_batches` (o destinatário e o histórico por conta dos avisos) —
as notificações são apagadas antes dos lotes, por causa da chave estrangeira.
Assim o reset não deixa rastro de lembretes nem um lote antigo `sent`
suprimindo o aviso de uma data.

Seguranças do procedimento:

1. Exibe o caminho absoluto do banco e o escopo exato (tabelas e contagens de registros) antes de qualquer alteração.
2. Bloqueia execução com `NODE_ENV=production` por padrão; a liberação explícita exige `DATABASE_RESET_ALLOW_PRODUCTION=true`.
3. Cria um backup consistente com `VACUUM INTO` (inclui dados ainda no WAL) em `server/backups/finance-reset-<modo>-<data>.db`. Se o backup falhar, a operação é abortada sem alterar nada.
4. Solicita confirmação interativa digitando `APAGAR`; qualquer outro valor cancela sem tocar nos dados.
5. Executa as exclusões em transação, na ordem das chaves estrangeiras, e preserva o histórico de migrações.
6. Verifica `integrity_check` e `foreign_key_check` ao final e reaplica as migrações oficiais.

Os bancos de destino são configuráveis por `DATABASE_PATH` e `BACKUP_DIR`. Os backups de reset nunca são sobrescritos automaticamente.

### Backup manual

1. Pare o backend (`Ctrl+C`).
2. Copie `server/data/finance.db` para um local seguro.

Com o aplicativo parado, o SQLite faz checkpoint do WAL no encerramento. Se preferir copiar com o app aberto, use o comando de backup acima.

### Restauração

Procedimento oficial (interativo):

```powershell
npm.cmd run db:restore
```

Sem argumentos, o comando lista os backups disponíveis em `server/backups/` (mais recente primeiro) para escolha por número. Também aceita um arquivo direto:

```powershell
npm.cmd run db:restore -- finance-reset-data-2026-10-20T00-00-00-000Z.db
```

Antes de substituir, o comando valida o arquivo escolhido (integridade e tabelas essenciais), cria um backup de segurança do estado atual em `server/backups/finance-pre-restore-<data>.db` e pede a confirmação `RESTAURAR`. Após a troca, reaplica as migrações oficiais e verifica a integridade; se algo falhar, o banco anterior volta ao lugar automaticamente. Mantenha o aplicativo parado durante a restauração.

Alternativa manual:

1. Pare o aplicativo.
2. Substitua `server/data/finance.db` pelo arquivo de backup.
3. Remova `finance.db-wal` e `finance.db-shm`, se existirem.
4. Inicie o aplicativo novamente.

Os backups guardam dados financeiros sensíveis: mantenha-os em local protegido.

## Testes

```powershell
npm.cmd test
```

A suíte cobre:

- conversão de moeda brasileira e rejeição de formatos ambíguos;
- leitura de datas brasileiras, ISO e do Excel;
- normalização de nomes e integridade dos cadastros;
- criação, edição, exclusão, filtros, ordenação e paginação de lançamentos;
- ordenação crescente/decrescente por categoria e por nome de pagamento, com filtros e ao longo das páginas;
- edição e exclusão em massa;
- importação de CSV/XLSX, correção de erros, duplicidades e reimportação;
- detecção de transferências: sinais opostos, descrições diferentes, datas próximas, tolerância, casos ambíguos e vínculo entre lotes distintos;
- transferências: vínculo/desvínculo, prevenção de vínculos duplicados, validação de valor/sinal/conta, bloqueios de edição/exclusão, preservação da marcação original e exclusão dos totais de receita/despesa;
- cores das categorias: persistência, atualização, limpeza, validação de formato e integridade após reaplicar migrações;
- consolidado anual: agrupamento, sinais, transferências, médias e totais;
- lembretes por e-mail: marcos, consolidação por marco, idempotência, retentativa e limite de tentativas, privacidade do e-mail (sem valor), sanitização de erro (host, usuário, senha e valor redigidos), TLS obrigatório, pré-visualização (`dry-run`) que não consome o aviso, CLI e escopo do reset.

## Decisões de arquitetura

- **Monorepo com workspaces**: um único `npm install` e um único `npm run dev`.
- **SQLite local**: simples de operar, sem servidor de banco, com transações e integridade referencial.
- **Relatório calculado sob demanda**: o consolidado sempre reflete os lançamentos atuais, sem risco de resumo desatualizado.
- **Seleção fora das páginas**: o contexto de seleção fica acima do roteador, então a seleção sobrevive à navegação e aos filtros.
- **Normalização centralizada**: a mesma regra vale para cadastros, busca e detecção de duplicidades.
- **Transferência como entidade própria**: o vínculo fica na tabela `transfers` (um par saída/entrada), enquanto a marcação textual do arquivo é preservada em `transactions.transfer` como evidência. O estado exibido na interface é derivado, não confiado ao texto importado.

## Limitações

- Aplicação local para uso individual; não há autenticação nem controle de acesso.
- Apenas a primeira planilha de cada arquivo é lida.
- O arquivo original da importação não é guardado, apenas o histórico do lote.
- Importe apenas arquivos de origem confiável.
- A detecção de transferências é heurística. O vínculo manual valida valor, sinal e contas, mas não exige proximidade de datas nem palavras-chave na descrição.
- Transferências não cruzam dados de terceiros nem validam titularidade real das contas; a decisão final é sempre do usuário.
- Uma reimportação de arquivo pode criar uma transferência duplicada se o par já existir e os lançamentos não tiverem sido vinculados antes.
- O e-mail de lembrete **não informa valores**: apenas descrição, vencimento, prazo restante, categoria, quantidade de itens e marco. Quem quiser os valores precisa abrir o aplicativo.
- A **descrição da conta vai no e-mail**: é texto livre e pode conter dado pessoal — evite nome de pessoa, documento ou outra informação sensível nela.
- Os lembretes avisam apenas contas **pendentes** (`AG` e `PG` nunca são avisadas) e dependem do backend no ar: sem servidor rodando, não há aviso — os marcos só são recuperados depois, dentro da janela de catch-up.
- Marcos cujo vencimento ficou para trás além da janela de catch-up são descartados, e não há reenvio manual de um marco já perdido.
- Cada aviso é tentado no máximo **5 vezes**; depois disso é descartado e fica registrado no histórico (`falha persistente: limite de tentativas`).
- Com `BILL_REMINDER_TRANSPORT=dry-run` nada é enviado e o agendador nem sobe — o aviso do dia não é consumido.
- A CLI (`npm.cmd run reminders:run`) **pode** rodar com o backend no ar: a reserva atômica do lote no banco garante um único envio por marco em condições normais. A garantia é *at-least-once* (pode haver reenvio se o processo cair entre a aceitação pelo SMTP e a gravação de `sent`).
- Não há confirmação de leitura, assinatura digital, configuração pela interface nem canal além de e-mail (WhatsApp e afins ficaram fora do escopo).

## Solução de problemas

**`npm.ps1` bloqueado no PowerShell**  
Use `npm.cmd` (ou ajuste a política de execução do PowerShell).

**Falha ao carregar `better-sqlite3`**  
Rode `npm.cmd rebuild better-sqlite3`. Confirme que o Node foi instalado com suporte a módulos nativos.

**Porta em uso**  
Altere com `$env:PORT = "4000"` e reinicie. Para o frontend, ajuste também o proxy em `client/vite.config.ts` ou use a versão de produção.

**Recomeçar com banco vazio**  
Pare o aplicativo e remova `server/data/finance.db`, `finance.db-wal` e `finance.db-shm`. As migrações serão reaplicadas na próxima inicialização.
