---
description: Pipeline completo com gates — plano, código, testes, review, QA, regressão e commit
agent: lead
---

Entrega: $ARGUMENTS

Execute o pipeline com **todos** os gates na ordem: planner (G0) → implementer (G1) → test-author (G2) → reviewer + security (G3) → qa (G4) → regression (G5) → git-commit (G6).

Regras:
- Não pule gate, não aceite "passou" sem a saída literal do comando.
- Rode reviewer, security e (quando independentes) qa em paralelo.
- Se um gate falhar, devolva ao subagente certo com o erro colado. Máximo 3 ciclos por gate; no 3º, pare e escale.
- Não faça push.

Gate de build no estado atual:

!`git status --short && echo "--- scripts:" && node -e "const p=require('./package.json');console.log(JSON.stringify(p.scripts||{},null,1))"`
