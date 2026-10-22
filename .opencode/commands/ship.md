---
description: Entrega leve — implementação direta e verificação proporcional
agent: lead
---

Entrega: $ARGUMENTS

Implemente diretamente como agente principal: entenda o pedido, faça a menor mudança necessária, atualize testes relevantes e valide de forma proporcional ao risco.

Regras:
- Use `reviewer` para banco, dinheiro, concorrência, autenticação, integração externa ou revisão solicitada.
- Use `security` apenas para credenciais, permissões, autenticação, rede ou dado sensível.
- Use qualquer outro subagente apenas quando o usuário pedir ou houver investigação independente que reduza tempo ou risco.
- Rode teste focado durante a mudança; rode build e suíte completa uma vez antes de commit de código. Não repita verificação se o diff não mudou.
- Só chame `git-commit` se o pedido incluir commit. Push, PR e merge exigem autorização humana explícita e separada.

Ambiente: Bash em Linux, gerenciador **npm** (workspaces). Não use `pnpm` nem comandos PowerShell. Não existe script `lint` — typecheck é `npm run build`.

Gate de build no estado atual:

!`git status --short && echo "--- scripts:" && node -e "const p=require('./package.json');console.log(JSON.stringify(p.scripts||{},null,1))"`
