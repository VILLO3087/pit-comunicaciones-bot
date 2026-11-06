
async function sendNoInternetGuide(to) {
  console.log(`Iniciando guía visual de conexión para ${to}.`);

  await sendWhatsAppMessage(
    to,
    `📡 *VAMOS A REVISAR TU CONEXIÓN*

Te guiaremos paso a paso. Observa las fotografías y sigue las instrucciones en el orden indicado.

⚠️ No desconectes ningún cable de la corriente eléctrica.`
  );

  // PASO 1: ADAPTADOR PoE
  await sendWhatsAppImage(
    to,
    POE_IMAGE_URL,
    `🔌 *PASO 1. ADAPTADOR PoE*

Identifica los dos cables de red:

⚫ Cable negro: está conectado en el puerto que dice *POE*.
⚪ Cable gris: está conectado en el puerto que dice *LAN*.

1. Desconecta el cable negro del puerto POE.
2. Vuelve a conectarlo en ese mismo puerto.
3. Desconecta el cable gris del puerto LAN.
4. Vuelve a conectarlo en ese mismo puerto.

🚨 No intercambies las posiciones de los cables. Cada cable debe regresar a su puerto original.`
  );

  // PASO 2: ROUTER
  await sendWhatsAppImage(
    to,
    ROUTER_IMAGE_URL,
    `📶 *PASO 2. ROUTER WiFi*

Identifica el cable de red conectado en el puerto que dice *WAN*.

1. Desconecta ese cable del puerto WAN.
2. Vuelve a conectarlo en el mismo puerto WAN.

⚠️ No lo conectes en los puertos LAN amarillos ni en otro puerto.`
  );

  // PASO 3: ESPERA Y VERIFICACIÓN
  await sendWhatsAppMessage(
    to,
    `⏳ *PASO 3. ESPERA Y VERIFICA*

1. Asegúrate de que los cables estén nuevamente conectados en sus puertos originales.
2. Espera de 3 a 5 minutos.
3. Comprueba si ya tienes acceso a Internet.

🚨 *MUY IMPORTANTE*

❌ No presiones el botón RESET del router.
❌ No cambies los cables de posición.
❌ No desconectes otros cables.
❌ No manipules la antena ni el cableado exterior.

¿Ya tienes Internet?

Responde:
✅ *SI* — Si ya funciona.
❌ *NO* — Si continúa sin funcionar.

💙 *PIT COMUNICACIONES*`
  );

  console.log(`Guía visual enviada a ${to}.`);
}
