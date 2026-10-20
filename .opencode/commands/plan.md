---
description: Planeja uma mudança sem editar código (arquiteto + critérios de aceite)
agent: planner
---

Objetivo: $ARGUMENTS

Leia o `AGENTS.md` e o contexto relevante do repositório. Produza o plano completo (interpretação, critérios de aceite testáveis, contexto com arquivo:linha, design/contratos, passos, estratégia de teste, riscos, fora de escopo).

Se houver ambiguidade que mude o design, liste as perguntas e **não** prossiga com o plano.

Contexto atual do repositório:

!`git status --short && echo "---" && git log --oneline -5`
