# Security Bot

Módulo independente de testes defensivos de licença, sessão e Relay.

## Isolamento

Todo código específico do Security Bot deve permanecer dentro de `apps/security-bot/`. O Visual Bot não deve importar arquivos deste módulo. A infraestrutura raiz pode apenas rotear requisições para o módulo.

Este diretório pode ser removido integralmente sem que analisadores do Visual Bot dependam de sua implementação.
