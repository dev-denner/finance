---
description: Pipeline completo com gates — plano, código, testes, review, QA, regressão e commit
agent: lead
---

Entrega: $ARGUMENTS

Execute o pipeline automático na ordem: planner (G0) → implementer (G1) → test-author (G2) → reviewer + security (G3) → qa (G4) → regression (G5) → git-commit (G6). G7 (publicação) é separado e só pode ocorrer após autorização humana explícita.

Regras:
- Não pule gate, não aceite "passou" sem a saída literal do comando.
- Rode `reviewer` e `security` na mesma rodada (são independentes).
- **Máximo de 2 rodadas por gate**; na 2ª, se ainda falhar, pare e escale ao usuário.
- Reexecute um gate somente se o diff mudou (`git diff HEAD | sha256sum`). Hash igual = reaproveite o veredito.
- **`git-commit` é o último passo** e só entra com G1–G5 verdes. Nenhum commit antes disso.
- Execuções da suíte completa: máximo 2 (G1 e G5). Nos demais gates, rode escopo (`npm run test -w server -- tests/<arquivo>.test.ts`).
- Orçamento do ciclo: 8 delegações, 45 min. Ao estourar, pare e reporte o estado parcial.
- Ao concluir G6, informe branch, upstream, commits à frente/atrás e peça autorização humana explícita para G7. Se autorizada, publique somente a branch atual, sem force, e confirme a SHA no remoto. Não crie PR ou merge.

Ambiente: Bash em Linux, gerenciador **npm** (workspaces). Não use `pnpm` nem comandos PowerShell. Não existe script `lint` — typecheck é `npm run build`.

Gate de build no estado atual:

!`git status --short && echo "--- scripts:" && node -e "const p=require('./package.json');console.log(JSON.stringify(p.scripts||{},null,1))"`
