---
description: Corrige um bug começando pelo teste que o reproduz
agent: lead
---

Bug: $ARGUMENTS

Ordem obrigatória:
1. Localize a causa com evidência (`arquivo:linha`), sem adivinhar.
2. Escreva ou atualize um teste que falhe antes da correção, quando o cenário for automatizável.
3. Aplique a correção mínima e rode o teste focado.
4. Rode build e a suíte completa apenas antes de commit, quando o risco ou o escopo justificar.
5. Só chame `reviewer` para mudanças de risco alto (banco, dinheiro, concorrência, autenticação ou integração externa), ou se o usuário pedir.
6. Só chame `git-commit` se o pedido incluir commit. Push, PR e merge exigem autorizações explícitas e separadas.

Regras:
- Não repita testes ou revisões se o diff não mudou e não houver nova evidência.
- Ambiente: Bash, **npm** (não `pnpm`), sem script `lint`.

Se não conseguir reproduzir em 2 tentativas, pare e reporte o que falta (dado, acesso, log, ambiente) em vez de aplicar um fix especulativo.
