# Control y Verificación de Pagos Bancolombia

Herramienta protegida en tiempo real para verificar pagos reales recibidos por correo electrónico (Gmail, Hotmail/Outlook u otro IMAP), evitar comprobantes falsos, anunciar el monto en voz alta (`"Has recibido [monto] pesos"`), conectar **2 o 3 teléfonos** simultáneamente y descargar **reportes PDF** para cruce de cuentas.

## Seguridad Criptográfica Integrada
- **Inicio de sesión obligatorio:** Ninguna pantalla, endpoint, reporte PDF ni conexión WebSocket funciona sin iniciar sesión.
- **Cero contraseñas en texto plano:** Tanto el usuario como la contraseña de acceso se validan exclusivamente mediante derivación criptográfica irreversible **`scrypt` (512 bits + sal aleatoria de 256 bits)** y comparación en tiempo constante (`timingSafeEqual`) en `src/security.js`, con bloqueo automático contra ataques de fuerza bruta.
- **Cambio de credenciales solo por código:** No existe ningún botón ni ruta web para ver ni cambiar la clave de acceso. Para cambiarla desde tu computador ejecuta:
  ```bash
  node src/security.js generar-credenciales "NUEVO_USUARIO" "TuNuevaClaveSegura"
  ```
  y pega el bloque resultante `DEFAULT_ADMIN_AUTH` en `src/security.js`.
- **Contraseña de Aplicación cifrada (`AES-256-GCM`):** La clave de aplicación del correo se guarda cifrada con autenticación `AES-256-GCM` y nunca puede leerse ni consultarse desde el navegador ni desde las respuestas del servidor.

## Cómo iniciar en local
1. Haz doble clic en **`Iniciar Control Pagos.bat`**.
2. Inicia sesión con tus credenciales de administrador.

## Configurar tu correo (Prueba inicial con `jhocamza@gmail.com`)
1. Haz clic arriba a la derecha en **⚙️ Configurar Correo**.
2. Ingresa la **Contraseña de Aplicación** de 16 letras de tu Gmail (`https://myaccount.google.com/apppasswords`), pulsa **🔌 Probar Conexión** y luego **💾 Guardar y Cifrar**.
3. Cuando pases a operación real con el banco, abre **⚙️ Configurar Correo** y pulsa **🏦 Oficial Bancolombia**.
