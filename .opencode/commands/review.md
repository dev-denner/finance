---
description: Revisão crítica do diff atual com veredito e severidade
agent: reviewer
---

Revise o diff atual (`git diff` e `git diff --staged`), lendo os arquivos completos dos trechos alterados.

Rode `npm run build` e os testes você mesmo antes de dar veredito. Emita: veredito (APROVADO / APROVADO COM RESSALVAS / BLOQUEADO), contagem por severidade, achados com `arquivo:linha` + impacto + diff de correção, o que está bom, e lacunas de teste.

Leia primeiro o arquivo de evidência do lead (`qa/evidence/<tema>.md`) se existir — ele já traz plano, AC e o que já foi revisado. Não reexplore o repositório inteiro.

Ambiente: Bash em Linux, gerenciador **npm** (workspaces). Não use `pnpm` nem comandos PowerShell.

Foco extra: $ARGUMENTS

!`git diff --stat && echo "--- staged:" && git diff --staged --stat`
