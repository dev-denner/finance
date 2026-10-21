---
description: Planeja uma mudança sem editar código (arquiteto + critérios de aceite)
agent: planner
---

Objetivo: $ARGUMENTS

Leia o `AGENTS.md` e o contexto relevante do repositório. Produza o plano completo (interpretação, critérios de aceite testáveis, contexto com arquivo:linha, design/contratos, passos, estratégia de teste, riscos, fora de escopo).

Ambiente: Bash em Linux, gerenciador **npm** (workspaces). Não existe script `lint` — typecheck é `npm run build`. Não use comandos PowerShell (`Get-Content`, `Select-String`, `dir`).

Se houver ambiguidade que mude o design, liste as perguntas e **não** prossiga com o plano.

Escreva também o resumo do plano no arquivo de evidência `qa/evidence/<tema>.md` — é ele que os próximos agents vão ler, em vez de reexplorar o repositório.

Contexto atual do repositório:

!`git status --short && echo "---" && git log --oneline -5`
