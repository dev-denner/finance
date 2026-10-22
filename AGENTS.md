# AGENTS.md — regras do repositório Finance

> Lido por todos os agentes. Comandos reais do projeto; não inventar scripts.

## Stack

- Linguagem: TypeScript (strict)
- Runtime/dev: Node 20+ (testado com Node 24) · npm (workspaces)
- Framework: Fastify 5 (backend) · React 19 + Vite (frontend)
- Banco/ORM: SQLite (better-sqlite3) + Drizzle ORM
- Testes: Vitest
- Lint/format: tsc (typecheck) — sem ESLint/Prettier configurados

## Comandos (fonte da verdade)

| Etapa | Comando |
|---|---|
| instalar | `npm install` |
| typecheck (server) | `npm run build -w server` (tsc) |
| typecheck (client) | `npm run build -w client` (tsc) |
| typecheck (all) | `npm run build` |
| unit | `npm test` |
| unit (watch) | `npm run test:watch` |
| build | `npm run build` |
| dev | `npm run dev` |
| db:generate | `npm run db:generate` |
| db:migrate | `npm run db:migrate` |
| db:backup | `npm run db:backup` |
| db:reset:data | `npm run db:reset:data` |
| db:reset:all | `npm run db:reset:all` |
| db:restore | `npm run db:restore` |
| reminders:run | `npm run reminders:run` |

## Gate de qualidade

1. `npm run build` sem erro (server + client)
2. `npm test` verde (Vitest)
3. nenhuma regressão vs baseline (362 testes: 336 no server + 26 no client)
4. sem `console.log`, `debugger`, `.only`, `.skip`
5. nenhuma variável de ambiente nova sem entrada no README
6. sem segredo, token ou PII em código, log ou teste
7. docs atualizadas se o comportamento público mudou
8. o plano do módulo (`qa/evidence/<tema>.md`) entra no **mesmo commit** da feature que ele descreve

## Convenções

- TypeScript strict; `any` novo exige justificativa em comentário.
- Validação de entrada com Zod na fronteira (route handler).
- Erros: `HttpError` tipado — nunca `catch {}` mudo.
- Nome de arquivo: `kebab-case.ts`/`.tsx`; componente: `PascalCase.tsx`.
- Teste ao lado do arquivo (`x.test.ts`); e2e não configurado.
- Imports relativos (sem alias `@/`).

## Git

- Conventional Commits com Gitmoji: `<gitmoji> <type>(<scope>): <resumo>`.
- Branch: `feat/`, `fix/`, `chore/` + slug curto.
- Commit atômico após os gates de qualidade. Um commit local **não** conclui a entrega remota.
- Depois de commitar, informe branch, upstream, commits à frente/atrás e peça autorização explícita para publicar. Sem essa autorização, não execute `git push`.
- Com autorização explícita do usuário para a branch atual, publique somente essa branch e confirme o resultado no remoto. PR, merge, force push, `--no-verify` e rebase em branch compartilhada continuam exigindo autorização explícita e separada.

## Proibições

- Adicionar dependência sem aprovação.
- Alterar schema/migração sem backup prévio.
- Desabilitar teste ou `@ts-ignore` para ficar verde.
- Editar `.env`, lockfile alheio à mudança, ou arquivo gerado versionado.
- Commitar banco SQLite real, backups, dumps, CSV/Excel financeiros, `.env`, tokens, credenciais, `node_modules`, `dist`, `coverage`, logs.

## Estrutura

```
client/         SPA React (Vite)
server/
  drizzle/      migrações SQL + journal
  src/
    db/         schema, conexão, migrações, backup/reset/restore
    lib/        moeda, datas, normalização, parcelas
    routes/     endpoints Fastify
    services/   regras de negócio
  tests/        Vitest
package.json    scripts do monorepo (npm workspaces)
```
