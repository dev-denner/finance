---
description: Roda o gate de qualidade (typecheck e testes) e reporta só o que falhou
agent: lead
---

Rode o gate de qualidade completo e relate apenas:
1. o comando exato executado por etapa;
2. status (verde/vermelho) e, se vermelho, o erro literal (primeiras linhas do stack);
3. a menor correção proposta para cada falha — **sem aplicar** ainda.

Etapas: typecheck → unit → e2e (se aplicável). **Não existe etapa `lint`** neste repositório.
Use os comandos do `AGENTS.md`; não invente script que não existe no `package.json`.

Ambiente: Bash em Linux, gerenciador **npm** (workspaces). Não use `pnpm` nem comandos PowerShell.

Ao final, confirme que `git status --short` está vazio.

!`node -e "const p=require('./package.json');console.log(JSON.stringify(p.scripts||{},null,1))"`
