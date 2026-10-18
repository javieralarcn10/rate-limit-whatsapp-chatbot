# rate-limit-whatsapp-chatbot-example

Cómo evito que alguien mande mensajes sin parar a mi agente de soporte de WhatsApp y me deje una factura de miles de euros en tokens de IA.

Cada mensaje que entra por WhatsApp acaba en una llamada al modelo, y cada llamada cuesta dinero. Un script que mande un mensaje por segundo durante una noche son más de 30.000 llamadas, cada una con el historial de la conversación dentro. Este repo es una versión mínima y funcional del sistema que uso en producción para que eso no pase.

Stack: [Hono](https://hono.dev) + [Chat SDK](https://chat-sdk.dev) + [Zernio](https://zernio.com) para WhatsApp + [AI SDK](https://ai-sdk.dev) con Vercel AI Gateway + Redis.

## Las tres capas

### 1. Ventanas de mensajes por conversación

Dos contadores en Redis por cada conversación (número de WhatsApp + cliente):

| Ventana | Límite |
|---|---|
| 2 minutos | 30 respuestas de la IA |
| 24 horas | 150 respuestas de la IA |

Si se pasa de cualquiera de los dos, el mensaje no llega al modelo.

### 2. Debounce

Si el cliente manda 5 mensajes seguidos ("hola", "una pregunta", "sobre mi pedido"...), no tiene sentido responder 5 veces. El Chat SDK espera 10 segundos desde el último mensaje y responde a todos juntos con una sola llamada a la IA.

Contra un ataque esto es lo que más dinero ahorra: 1.000 mensajes enviados de golpe cuestan una respuesta, no mil. Y como cada respuesta necesita 10 segundos de silencio antes, una conversación no puede generar más de 6 respuestas por minuto. La ventana de 2 minutos queda como red de seguridad por si bajas el debounce.

### 3. Aviso y bloqueo en WhatsApp

La primera vez que alguien supera un límite de la capa 1, el bot le contesta con un aviso: si manda un mensaje más, el número quedará bloqueado. Si vuelve a escribir mientras sigue por encima del límite, se bloquea.

El bloqueo se hace en WhatsApp, no en mi servidor. Zernio expone la API de bloqueo de Meta (`zernio.whatsapp.blockWhatsAppUsers()`), y un número bloqueado ya no puede escribirte: sus mensajes no llegan a Zernio ni al webhook, así que no te cuestan nada, ni en tokens ni en servidor.

El aviso dura lo mismo que la ventana que se ha superado. Si alguien se pasa del límite de 2 minutos y espera a que caduque, vuelve a empezar de cero sin bloqueo.

Mientras Meta aplica el bloqueo, o si la llamada a Zernio falla, una clave en Redis mantiene al bot en silencio con ese número durante 24 horas.

### Detalles que importan

- **El límite se comprueba antes de cualquier trabajo que cueste dinero.** Si tu agente transcribe audios o analiza imágenes, eso también son tokens. El `checkRateLimit` va lo primero.
- **El aviso se manda una sola vez.** El siguiente mensaje por encima del límite ya no recibe respuesta: se bloquea. Si el bot contestara a cada mensaje con "has alcanzado el límite", el atacante te seguiría costando dinero en mensajes de WhatsApp.
- **Fail-open.** Si Redis se cae, los mensajes pasan. Prefiero una respuesta de más a un bot de soporte que deja de contestar a clientes reales.
- **Contadores atómicos.** `INCR` y `EXPIRE NX` van en la misma transacción. Si el proceso muere entre los dos, nunca queda un contador sin caducidad que bloquee al usuario para siempre.
- **Firma y duplicados.** El adapter de Zernio verifica la firma HMAC de cada webhook y el Chat SDK descarta los reintentos duplicados, así que nadie puede llamar al endpoint directamente y un reintento de Zernio no provoca una segunda respuesta.
- **Tope de tokens por respuesta.** `maxOutputTokens: 800` en el agente. Ninguna llamada puede salir más cara de lo previsto.

## Flujo de un mensaje

```
WhatsApp -> Zernio -> POST /webhooks/zernio
  -> verificar firma HMAC (si falla, 401)
  -> descartar si es un duplicado
  -> debounce de 10 s (agrupa los mensajes seguidos)
  -> checkRateLimit()
       por encima del límite por primera vez -> aviso de bloqueo y parar
       por encima del límite tras el aviso   -> bloqueo en WhatsApp y parar
  -> llamada a la IA con los últimos 20 mensajes del historial
  -> respuesta por WhatsApp a través de Zernio
```

## Estructura

```
src/
  index.ts        servidor Hono con el endpoint del webhook
  bot.ts          Chat SDK + adapter de Zernio, debounce y handler de mensajes
  rate-limit.ts   capas 1 y 3
  zernio.ts       bloqueo y desbloqueo de números en WhatsApp
  unblock.ts      script para desbloquear un número a mano
  agent.ts        llamada al modelo con AI SDK
  redis.ts        conexión compartida a Redis
```

## Puesta en marcha

Necesitas:

- Node.js 20 o superior
- Redis (en local vale con `brew install redis && redis-server`, o usa uno gestionado)
- Una cuenta de Zernio con un número de WhatsApp conectado y el addon de Inbox activado
- Una API key de [Vercel AI Gateway](https://vercel.com/ai-gateway)

```bash
git clone <este-repo>
cd rate-limit-whatsapp-chatbot
npm install
cp .env.example .env   # rellena las claves
npm run dev
```

Para recibir webhooks en local, expón el puerto con un túnel:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

En el panel de Zernio, crea un webhook con:

- **URL:** `https://<tu-tunel>/webhooks/zernio`
- **Evento:** `message.received`
- **Secret:** el mismo valor que pongas en `ZERNIO_WEBHOOK_SECRET`

Escribe al número de WhatsApp y el agente te contestará.

## Ajustar los límites

Todo está en constantes al principio de `src/rate-limit.ts`:

| Constante | Valor | Qué controla |
|---|---|---|
| `BURST_LIMIT` / `BURST_WINDOW_SEC` | 30 / 2 min | Ráfaga máxima |
| `DAILY_LIMIT` / `DAILY_WINDOW_SEC` | 150 / 24 h | Máximo diario |
| `BLOCK_TTL_SEC` | 24 h | Cuánto tiempo ignora el bot al número en Redis (el bloqueo de WhatsApp no caduca) |

El debounce está en `src/bot.ts` (`debounceMs`). Los textos que ve el cliente (`WARNING_MESSAGE` y las instrucciones del agente) están en inglés: cámbialos al idioma de tus clientes.

Para saber cuánto puede costarte un número en el peor caso: 150 respuestas × (tokens del historial + tokens de salida) × precio del modelo. Después de eso, el número queda bloqueado.

## Desbloquear un número

El bloqueo de WhatsApp no caduca. Si bloqueas a un cliente real por error:

```bash
npm run unblock -- <zernioAccountId> <telefono>
```

También puedes hacerlo desde el panel de Zernio. Meta solo deja bloquear a usuarios que te hayan escrito en las últimas 24 horas, algo que aquí siempre se cumple.

## Lo que esto no cubre

El límite es por conversación. Alguien con cientos de números de WhatsApp podría repartir el ataque entre todos. Conseguir números de WhatsApp cuesta dinero y tiempo, así que es mucho menos habitual, pero si te preocupa, añade un contador global por día con el mismo `incrWithExpire` y corta cuando el gasto total pase de un umbral.

## Nota sobre el adapter de Zernio

`@zernio/chat-sdk-adapter` 0.5.1 crea los mensajes con el `threadId` vacío. Con la estrategia de debounce, el Chat SDK guarda los mensajes en Redis y al recuperarlos los enruta por ese campo, así que fallan todos con `Invalid Zernio thread ID format`. La clase `ZernioChat` de `src/bot.ts` lo rellena antes de que entre en la cola. Si una versión futura del adapter lo corrige, puedes volver a usar `Chat` directamente.
