# Visual — bots de QA visual

Laboratório separado dos projetos analisados. Ele **não altera o Projeto Daniel nem o repositório alvo**: recebe um alvo, procura sinais de bugs visuais/interativos e gera relatório.

## Melhor estratégia

Use **modo `repo` como padrão**. Ele clona/lê o código e funciona mesmo quando o site publicado tem login/proteção. Use **modo `url` como segunda camada** quando a página puder ser aberta pelo runner; aí Playwright testa Chromium + WebKit em desktop, iPhone e iPad.

A análise ideal é híbrida: código encontra padrões perigosos; navegador confirma o comportamento real. Um bot não deve corrigir automaticamente código de produção só porque encontrou uma heurística — primeiro gera evidência/relatório.

## Bots atuais

- `StateBot`: procura estados `active/selected/aria-selected` potencialmente presos.
- `TouchBot`: detecta `:hover` sem media query e ciclos touch/pointer incompletos.
- `ViewportBot`: procura `100vh`, `position: fixed` e riscos comuns de Safari/iOS.
- `FocusBot`: procura foco visual removido ou confundido com seleção.
- `InteractionBot`: no modo URL, clica controles e observa estado persistente.
- `RuntimeBot`: captura erros JS/console.

## Rodar pelo GitHub

Abra **Actions → Visual QA Bots → Run workflow**. Preencha:

- `target`: URL do repositório a analisar, por exemplo `https://github.com/owner/projeto.git`, ou a URL da página.
- `mode`: `repo` ou `url`.

Ao terminar, baixe o artifact `visual-qa-report`. O relatório principal é `reports/latest.md`; no modo URL também há screenshots.

## Local

```bash
npm install
npm run audit -- --mode repo --target https://github.com/owner/projeto.git

# página acessível
npx playwright install chromium webkit
npm run audit -- --mode url --target https://exemplo.com
```

## Site protegido

Se a proteção impedir acesso externo, o modo URL não consegue atravessá-la sem uma sessão de teste. Nesse cenário, rode `repo`. Futuramente pode ser adicionada uma sessão Playwright autenticada via GitHub Secrets, sem colocar credenciais no código.

## Próximas camadas recomendadas

1. regras específicas para React/Vue/HTML do projeto alvo;
2. teste de exclusividade de tabs (somente uma selecionada por grupo);
3. baseline visual e screenshot diff por viewport;
4. acessibilidade com axe;
5. geração automática de GitHub Issue com arquivo/linha/evidência;
6. somente depois, um modo opcional de correção em branch/PR — nunca commit automático no projeto analisado.
