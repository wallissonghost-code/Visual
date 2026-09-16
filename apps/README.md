# Apps

O repositório contém ferramentas independentes.

- `visual-bot/`: auditoria visual, estrutural e de código.
- `security-bot/`: testes defensivos de licença, sessão e Relay.

## Regra arquitetural

Um bot não importa código interno do outro. Integrações compartilhadas devem ser neutras e ficar fora dos módulos. A remoção completa de um diretório em `apps/` não deve quebrar a lógica específica do outro bot.

A migração da estrutura legada de `public/` e `src/` deve respeitar esta fronteira; novos recursos específicos devem ser criados dentro do respectivo módulo.
