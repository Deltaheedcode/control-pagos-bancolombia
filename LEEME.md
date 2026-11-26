# Control y Verificación de Pagos Bancolombia

Herramienta en tiempo real para verificar pagos reales recibidos por correo electrónico (Gmail, Hotmail/Outlook u otro IMAP), evitar comprobantes falsos, anunciar el monto en voz alta (`"Has recibido [monto] pesos"`), conectar **2 o 3 teléfonos** simultáneamente y descargar **reportes PDF** para cruce de cuentas.

## Cómo iniciar la aplicación
1. Haz doble clic en **`Iniciar Control Pagos.bat`**.
2. Se abrirá automáticamente en tu navegador `http://localhost:3000`.
   *(Mantén abierta la ventana negra mientras estés recibiendo pagos).*

## Configurar tu correo (Prueba inicial con `jhocamza@gmail.com`)
1. En la página, haz clic arriba a la derecha en **⚙️ Configurar Correo**.
2. El sistema ya viene preconfigurado con **`jhocamza@gmail.com`** como correo y como **Remitente Oficial de Prueba**.
3. Ingresa la **Contraseña de Aplicación** de 16 letras de tu Gmail:
   - Entra a `https://myaccount.google.com/apppasswords` (con Verificación en 2 pasos activa).
   - Crea una contraseña llamada `"Pagos Bancolombia"`, copia las 16 letras y pégalas en el campo **Contraseña de Aplicación**.
4. Haz clic en **🔌 Probar Conexión** y luego en **💾 Guardar y Conectar**.

## Cómo probar ahora mismo
- **Prueba rápida sin correo:** Pulsa **⚡ Simular Pago** arriba a la derecha, pon cualquier valor (ej. `50000`) y pulsa **Enviar Pago de Prueba**. Escucharás `"Has recibido cincuenta mil pesos"` y verás el pago en todas las pantallas conectadas.
- **Prueba real por correo:** Envíate un correo desde `jhocamza@gmail.com` con un texto como:
  > *Asunto:* Pago recibido
  > *Mensaje:* Recibiste una transferencia por $65.000
  En pocos segundos el sistema lo detectará en vivo, verificará que viene de `jhocamza@gmail.com` y lo leerá en voz alta.

## Pasar a operación real con Bancolombia
Cuando termines tus pruebas:
1. Abre **⚙️ Configurar Correo**.
2. Debajo de *Correo(s) Remitente(s) Oficial(es)*, haz clic en el botón **🏦 Oficial Bancolombia** y guarda.
   Esto reemplazará tu correo de prueba por los dominios oficiales de notificaciones de Bancolombia (`alertasynotificaciones@notificacionesbancolombia.com`, `alertasynotificaciones@bancolombia.com.co`, `notificaciones@bancolombia.com.co`).

## Conectar 2 o 3 teléfonos celulares
1. Conecta los celulares a la **misma red Wi-Fi** del computador.
2. En el computador haz clic en **📱 Teléfonos** y escanea el **Código QR** con la cámara de cada celular.
3. En cada celular toca una vez el aviso amarillo superior para activar el altavoz del navegador (puedes encender o apagar la voz de forma independiente en cada teléfono).
4. *Si el celular no carga la página al escanear el QR:* ejecuta una sola vez **`Permitir Red en Celulares.bat`** para autorizar el puerto `3000` en el Firewall de Windows.

## Descargar Reporte PDF para Cruce de Cuentas
- Elige el periodo (**Hoy**, **Ayer**, **Últimos 7 días**, **Este mes** o **Por fechas**) y pulsa **📄 Descargar Reporte PDF**.
- Obtendrás un PDF con cada pago detallado y al final el recuadro con la **SUMA TOTAL RECIBIDA**.
