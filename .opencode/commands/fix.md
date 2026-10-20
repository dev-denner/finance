---
description: Corrige um bug começando pelo teste que o reproduz
agent: lead
---

Bug: $ARGUMENTS

Ordem obrigatória:
1. Localize a causa com evidência (`arquivo:linha`), sem adivinhar.
2. `test-author` escreve o teste que **falha** reproduzindo o bug. Rode e cole a falha.
3. `implementer` aplica a correção mínima. Rode o teste: deve passar.
4. `regression` verifica que nada mais quebrou.
5. `git-commit` commita com `fix(escopo): ...` e o corpo explicando a causa raiz.

Se não conseguir reproduzir em 2 tentativas, pare e reporte o que falta (dado, acesso, log, ambiente) em vez de aplicar um fix especulativo.
