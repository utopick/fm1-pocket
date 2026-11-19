# Tether manual

[English](#english) · [Español](#español)

## English

### Installing it

Open FM1.Pocket, go to OPTIONS and then REAL FM-1, and press **PLAY WITH THE REAL FM-1**. The app walks you through
the same steps as any other firmware: it connects to the FM-1, makes a backup of it, adds the protector, and then
installs Tether. Keep the backup file, because it is your way back to exactly what the FM-1 had before.

When Tether starts, the FM-1's screen says TETHER at the top.

### The two ways it works

Tether watches for FM1.Pocket. When the app is open and talking to the FM-1, the FM-1 is the app's panel. When the app
is closed, or has been quiet for three seconds, the FM-1 becomes a normal USB MIDI keyboard. It switches between the
two on its own, so you never have to change a setting, and anything you're holding is let go when it switches.

### With FM1.Pocket

The FM-1's keys, knobs and buttons play the emulated FM-1 in the app, and whatever firmware the app is running shows
on the real screen and lights. Two buttons appear in the app's left column. The screen button chooses whether the app's
screen is also sent to the FM-1 (turning it off makes the link lighter). The sound button chooses whether the app's
sound comes out of the FM-1's own headphone or line output, or out of your phone or computer.

### As a MIDI keyboard

Plug the FM-1 into a computer or an Android phone and choose it as a MIDI input in your music app. It needs no driver.

The 27 keys send notes on channel 1, starting from F3. OCT- and OCT+ move the keys down or up by an octave, up to three
each way, and they don't send anything themselves.

The other 12 buttons are pads that send notes 36 to 47 on channel 10, from FX (36) to REC (47). They light up while
you hold them.

The knobs send CC messages on channel 1. KNOB1 to KNOB4 send CC 70 to 73, SELECT sends 74, ALGORITHM 75 and PRESETS 76.
Each click of a knob moves its value by 2, from 0 to 127, and every knob starts in the middle at 64. MASTER sends CC 7.

### What the screen shows

From top to bottom, the screen shows:

1. The name of the control you touched last, what it sends, and its value as a bar. A Pocket app can replace the name
   with what that control does in the app, such as SWING.
2. The tempo and the bar and beat, when a program sends MIDI clock, along with whether it is playing or stopped.
3. The chord you're holding, such as Cmaj7. When you aren't holding keys, it names the chord or scale a program has lit
   on the keys.
4. The octave and the MIDI channels.
5. A level meter for the sound the computer is playing through the FM-1.

### Lights

A program can light the FM-1's keys and pads by sending notes back to it, the same way you would light a Launchkey's
pads. A note on channel 10 from 36 to 47 lights a pad, and a note on channel 1 lights the key that plays that note.
A velocity from 64 to 127 gives a bright light, 1 to 63 a dim one, and 0 or a note-off turns it off. If a program
lights one key bright and the rest of a scale dim, the screen takes the bright key as the scale's root.

### The FM-1 as a speaker

Tether also makes the FM-1 a USB sound output. On a computer, choose it as the output in your sound settings (it may
appear with the name Felucca) and the computer's sound plays through the FM-1's headphone or line output. MASTER sets
the volume.

On a Mac, if the FM-1 doesn't appear as a sound output, unplug it and plug it in again with the browser closed, since a
browser can grab the FM-1 the moment it is plugged in.

### Using it with the other Pocket apps

TRACK.Pocket, TUNE.Pocket, SING.Pocket and PLAY.Pocket recognise the FM-1 when it runs Tether. Their DEVICE drawing
shows its layout, and its knobs and pads are given jobs straight away (in TRACK.Pocket, for example, MASTER is the
master volume). The first time, an app asks whether it may show its function names on the FM-1's screen. If you say
yes, the browser asks for permission to send it special MIDI messages, and that permission is only used for the names.

### Going back

To put M-VAVE's original firmware back, download FM-1.fwsc from M-VAVE, open it in FM1.Pocket with OPEN FIRMWARE FILE,
and install it the same way. You can also use the FM-1 Firmware Hub's installer. If the FM-1 ever stops starting up,
hold OCT- while switching it on to reach the USB rescue mode, and see WARNINGS in the app for the rest of the steps.

## Español

### Instalarlo

Abre FM1.Pocket, entra en OPCIONES y luego en FM-1 REAL, y pulsa **TOCAR CON EL FM-1 REAL**. La app te lleva por los
mismos pasos que con cualquier otro firmware: se conecta al FM-1, hace una copia de seguridad, añade el protector y
después instala Tether. Guarda la copia, porque es tu manera de volver exactamente a lo que tenía el FM-1.

Cuando Tether arranca, la pantalla del FM-1 pone TETHER arriba.

### Las dos maneras de funcionar

Tether está pendiente de FM1.Pocket. Cuando la app está abierta y hablando con el FM-1, el FM-1 es el panel de la app.
Cuando la app está cerrada, o lleva tres segundos callada, el FM-1 pasa a ser un teclado MIDI USB normal. Cambia de
una a otra solo, así que no hay que tocar ningún ajuste, y lo que tengas pulsado se suelta al cambiar.

### Con FM1.Pocket

Las teclas, los potes y los botones del FM-1 tocan el FM-1 emulado de la app, y el firmware que esté usando la app se
ve en la pantalla y las luces reales. En la columna izquierda de la app aparecen dos botones. El de la pantalla elige
si la pantalla de la app también se envía al FM-1 (si lo apagas, la conexión es más ligera). El del sonido elige si el
sonido de la app sale por la salida de auriculares o de línea del propio FM-1, o por tu móvil u ordenador.

### Como teclado MIDI

Conecta el FM-1 a un ordenador o a un móvil Android y elígelo como entrada MIDI en tu app de música. No necesita
ningún driver.

Las 27 teclas envían notas por el canal 1, empezando en F3. OCT- y OCT+ bajan o suben las teclas una octava, hasta
tres en cada sentido, y no envían nada por sí mismas.

Los otros 12 botones son pads que envían las notas 36 a 47 por el canal 10, de FX (36) a REC (47). Se encienden
mientras los mantienes pulsados.

Los potes envían mensajes CC por el canal 1. KNOB1 a KNOB4 envían los CC 70 a 73, SELECT envía el 74, ALGORITHM el 75
y PRESETS el 76. Cada clic de un pote mueve su valor de 2 en 2, de 0 a 127, y todos empiezan en el centro, en 64.
MASTER envía el CC 7.

### Qué muestra la pantalla

De arriba abajo, la pantalla muestra:

1. El nombre del último control que has tocado, lo que envía y su valor como una barra. Una app Pocket puede cambiar
   ese nombre por lo que hace ese control en la app, por ejemplo SWING.
2. El tempo, el compás y el tiempo, cuando un programa envía reloj MIDI, y si está sonando o parado.
3. El acorde que estás pulsando, por ejemplo Cmaj7. Cuando no pulsas ninguna tecla, nombra el acorde o la escala que
   un programa ha encendido en las teclas.
4. La octava y los canales MIDI.
5. Un medidor de nivel del sonido que el ordenador reproduce por el FM-1.

### Luces

Un programa puede encender las teclas y los pads del FM-1 enviándole notas, igual que se encienden los pads de un
Launchkey. Una nota por el canal 10 entre 36 y 47 enciende un pad, y una nota por el canal 1 enciende la tecla que
toca esa nota. Una velocidad de 64 a 127 da una luz fuerte, de 1 a 63 una luz suave, y 0 o un note-off la apaga. Si un
programa enciende una tecla fuerte y el resto de una escala suave, la pantalla toma la tecla fuerte como la tónica.

### El FM-1 como altavoz

Tether también convierte el FM-1 en una salida de sonido USB. En un ordenador, elígelo como salida en los ajustes de
sonido (puede aparecer con el nombre Felucca) y el sonido del ordenador sale por la salida de auriculares o de línea
del FM-1. MASTER controla el volumen.

En un Mac, si el FM-1 no aparece como salida de sonido, desconéctalo y vuelve a conectarlo con el navegador cerrado,
porque un navegador puede quedarse con el FM-1 en cuanto lo conectas.

### Con las otras apps Pocket

TRACK.Pocket, TUNE.Pocket, SING.Pocket y PLAY.Pocket reconocen el FM-1 cuando usa Tether. Su dibujo de DISPOSITIVO
muestra su distribución, y sus potes y pads tienen funciones desde el principio (en TRACK.Pocket, por ejemplo, MASTER
es el volumen general). La primera vez, la app pregunta si puede mostrar los nombres de sus funciones en la pantalla
del FM-1. Si dices que sí, el navegador pide permiso para enviarle mensajes MIDI especiales, y ese permiso solo se usa
para los nombres.

### Volver atrás

Para volver a poner el firmware original de M-VAVE, descarga FM-1.fwsc de M-VAVE, ábrelo en FM1.Pocket con ABRIR
FIRMWARE e instálalo de la misma manera. También puedes usar el instalador del FM-1 Firmware Hub. Si el FM-1 deja de
arrancar alguna vez, mantén OCT- pulsado al encenderlo para entrar en el modo de rescate USB, y mira AVISOS en la app
para el resto de los pasos.
