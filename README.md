# Finance

Aplicação web local para substituir a planilha de controle financeiro: importa lançamentos de CSV/Excel, permite editar em massa e gera o consolidado anual por categoria.

Tudo roda na sua máquina. Não há login, cloud, integração bancária, Docker ou serviço pago.

## Recursos

- **Importação** de CSV, XLS e XLSX com prévia, mapeamento manual de colunas, correção/rejeição de linhas, criação automática de categorias e formas de pagamento e detecção de duplicidades.
- **Transferências entre contas** detectadas na importação (valor de mesmo módulo, sinais opostos, contas diferentes e datas próximas), com revisão lado a lado antes de confirmar, vínculo persistente, desvínculo manual e indicador visual na listagem.
- **Lançamentos** em formato de planilha: filtros por ano/mês, categoria, pagamento e texto; ordenação (inclusive por **Categoria** e **Pagamento**, A–Z/Z–A); paginação; criação, edição inline e exclusão.
- **Edição em massa** de categoria, forma de pagamento e exclusão, mantendo a seleção entre páginas e filtros.
- **Consolidado anual** por categoria, com 12 colunas mensais, total, média e totais gerais, além da cor de cada categoria. Clique em uma célula para ver os lançamentos que a compõem.
- **Cadastros auxiliares** de categorias e formas de pagamento, com renomeação, **cor opcional por categoria** e exclusão com reatribuição.
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
│   │   └── pages/           # Lançamentos, Consolidado, Importações, Cadastros
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

## Importação

Formatos aceitos: `.csv`, `.txt`, `.xls`, `.xlsx` e `.xlsm` (primeira planilha do arquivo, até 20.000 linhas e 25 MB).

1. Arraste o arquivo ou selecione em **Importações**.
2. Confira o mapeamento das colunas obrigatórias: **Data Compra**, **Vencimento**, **Compra** e **Valor**.
3. Revise a prévia. Linhas com erro podem ser corrigidas ou rejeitadas individualmente.
4. Se houver pares candidatos de transferência, revise cada par lado a lado e escolha **Confirmar**, **Rejeitar** ou **Pendente**.
5. Escolha o tratamento de duplicidades e confirme a importação.

Regras relevantes:

- Datas aceitas como `DD/MM/AAAA`, `AAAA-MM-DD` e datas nativas do Excel.
- Valores como `-R$ 500,00`, `R$ 1.250,50` e `-R$ 500.00` são aceitos conforme o formato detectado. Formatos ambíguos, como `1,250`, são rejeitados em vez de adivinhados.
- Categorias e formas de pagamento inexistentes são criadas automaticamente, preservando o nome original de exibição e ignorando diferenças de caixa, acentos e espaços redundantes.
- A duplicidade é detectada por uma impressão digital dos campos do lançamento. Por padrão, duplicidades são ignoradas; desmarque a opção para importá-las mesmo assim.
- A importação inteira roda em uma transação do SQLite. O arquivo original não é armazenado nem alterado.
- Cada importação gera um registro no histórico com total, importados e rejeitados.

Também é possível criar lançamentos manualmente em **Lançamentos**.

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
# vínculos de transferência e rejeições de conciliação.
# Preserva categorias e formas de pagamento cadastradas.
npm.cmd run db:reset:data

# Reset completo: também apaga categorias e formas de pagamento.
npm.cmd run db:reset:all
```

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
- consolidado anual: agrupamento, sinais, transferências, médias e totais.

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

## Solução de problemas

**`npm.ps1` bloqueado no PowerShell**  
Use `npm.cmd` (ou ajuste a política de execução do PowerShell).

**Falha ao carregar `better-sqlite3`**  
Rode `npm.cmd rebuild better-sqlite3`. Confirme que o Node foi instalado com suporte a módulos nativos.

**Porta em uso**  
Altere com `$env:PORT = "4000"` e reinicie. Para o frontend, ajuste também o proxy em `client/vite.config.ts` ou use a versão de produção.

**Recomeçar com banco vazio**  
Pare o aplicativo e remova `server/data/finance.db`, `finance.db-wal` e `finance.db-shm`. As migrações serão reaplicadas na próxima inicialização.
