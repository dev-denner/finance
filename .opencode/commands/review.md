---
description: Revisão crítica do diff atual com veredito e severidade
agent: reviewer
---

Revise o diff atual (`git diff` e `git diff --staged`), lendo os arquivos completos dos trechos alterados. Use resultados de teste já disponíveis; não rode build ou suíte completa novamente sem motivo técnico concreto.

Rode `npm run build` e os testes você mesmo antes de dar veredito. Emita: veredito (APROVADO / APROVADO COM RESSALVAS / BLOQUEADO), contagem por severidade, achados com `arquivo:linha` + impacto + diff de correção, o que está bom, e lacunas de teste.

Ambiente: Bash em Linux, gerenciador **npm** (workspaces). Não use `pnpm` nem comandos PowerShell.

Foco extra: $ARGUMENTS

!`git diff --stat && echo "--- staged:" && git diff --staged --stat`
