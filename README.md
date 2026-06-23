# 🌷 Plantinha da Vovó

App web que **identifica a planta pela câmera do celular** e une o rigor da botânica com a **sabedoria de quem cuida de planta a vida toda**. UX pensada para pessoas idosas: fontes grandes, botões grandes, alto contraste e uma ação por vez.

**O que ela faz:**
- 🔎 Identifica a planta (nome popular, científico, família) e a confiança da resposta.
- 🩺 Avalia a **saúde** com um medidor de 0 a 100 e aponta problemas.
- 🏡 Diz **onde ela vive melhor** (ambiente, melhor lugar na casa, luz, clima, dificuldade).
- 🧴 Indica **o que aplicar** para cuidar, com produtos fáceis de achar no Brasil.
- 👵 Traz uma **Sabedoria da Vovó** — receita caseira tradicional e segura.
- 💬 **Pergunte à Vovó**: tire dúvidas sobre aquela planta num bate-papo carinhoso.
- 🔊 **Ouvir os cuidados**: leitura em voz alta (acessibilidade para baixa visão).
- 🌱 **Minhas plantas**: histórico das análises (via Firebase, opcional).

A análise usa um modelo de visão da Anthropic através de um **proxy serverless** — a chave da API fica **somente no servidor**, nunca no navegador.

```
.
├── index.html          # frontend (responsivo, chama /api/analisar)
├── api/analisar.js     # função serverless (proxy seguro da Anthropic)
├── vercel.json         # maxDuration da função
├── package.json
├── .env.example
└── .gitignore
```

---

## 1. Subir no GitHub

```bash
git init
git add .
git commit -m "Minha Plantinha - primeira versão"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/minha-plantinha.git
git push -u origin main
```

## 2. Publicar na Vercel

1. Acesse vercel.com → **Add New… → Project** → importe o repositório do GitHub.
2. Framework Preset: **Other** (não precisa de build).
3. Em **Settings → Environment Variables**, adicione:
   - `ANTHROPIC_API_KEY` = sua chave `sk-ant-...`
4. **Deploy**.

A função fica disponível automaticamente em `https://seu-app.vercel.app/api/analisar`. O `index.html` já chama esse endereço por caminho relativo (`/api/analisar`), então nada precisa ser alterado.

> Importante: a chave **não** vai no GitHub. Só nas variáveis de ambiente da Vercel.

---

## 3. (Opcional) Histórico no Firebase — "Minhas plantas"

O app funciona 100% sem Firebase. Ao configurá-lo, aparece o botão **Minhas plantas**, que guarda cada análise (nome, saúde, miniatura e o resultado completo) por usuário.

1. Crie um projeto em https://console.firebase.google.com
2. **Authentication → Sign-in method → Anonymous → Ativar** (login transparente, sem cadastro — ideal para o público idoso).
3. **Firestore Database → Criar banco** (modo produção).
4. **Project Settings → Seus apps → Web (`</>`)** e copie o objeto `firebaseConfig`.
5. Cole esses valores no topo do `<script type="module">` em `index.html`, no objeto `FIREBASE_CONFIG`.

### Regras de segurança do Firestore (cole em Firestore → Rules)

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /analyses/{doc} {
      allow read, write: if request.auth != null
        && request.resource.data.uid == request.auth.uid;
      allow read: if request.auth != null && resource.data.uid == request.auth.uid;
    }
  }
}
```

Isso garante que cada pessoa só acessa as próprias análises.

### Observação de escala
As miniaturas são salvas pequenas (240px, ~10–15 KB) dentro do documento — suficiente para uso pessoal e bem abaixo do limite de 1 MB do Firestore. Se o volume crescer muito, o caminho recomendado é mover as imagens para o **Firebase Storage** e guardar só a URL no Firestore.

---

## Decisões técnicas

- **Proxy serverless (Node, não Edge):** suporta o corpo com a imagem em base64 com folga e mantém a chave fora do cliente. Timeout de 50 s no servidor e 55 s no cliente.
- **Imagem redimensionada no aparelho** (máx. 1024 px) antes de enviar: menos dados na rede móvel, resposta mais rápida.
- **Câmera nativa** via `input capture="environment"`: abre a câmera que a pessoa já conhece e é mais confiável que `getUserMedia`. Há botão alternativo para a galeria.
- **Degradação graciosa:** sem Firebase configurado, o histórico simplesmente não aparece; o resto funciona igual.
- **Acessibilidade:** base 19 px, alvos de toque ≥ 66 px, foco visível por teclado, `prefers-reduced-motion` respeitado.

## Rodar localmente

```bash
npm i -g vercel
vercel dev        # sobe front + /api juntos; defina ANTHROPIC_API_KEY no .env.local
```

---

EDP Sistemas · Feito com 🌱
