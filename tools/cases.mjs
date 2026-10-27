/* The three cases people search for, one page each, in every language.
 *
 * Each page answers one search the way someone with a broken file types it,
 * says what really happened to the file, and sends them to the tool. Nothing
 * here claims more than argano does: the same limits as the main page, said
 * again where the hope is highest.
 *
 * tools/pages.mjs writes them to web/<slug>/, web/it/<slug>/ and
 * web/es/<slug>/, and links them from the first screen and the sitemap.
 */

export const UI = {
  en: {
    guidesTitle: 'Common cases',
    cta: 'Repair it now, free',
    ctaFine: 'Nothing is uploaded and there is no account. The repair runs in your browser.',
    others: 'Other cases',
    back: 'argano',
  },
  it: {
    guidesTitle: 'I casi più comuni',
    cta: 'Riparalo adesso, gratis',
    ctaFine: 'Non si carica niente e non serve un account. La riparazione avviene nel tuo browser.',
    others: 'Altri casi',
    back: 'argano',
  },
  es: {
    guidesTitle: 'Los casos más comunes',
    cta: 'Repáralo ahora, gratis',
    ctaFine: 'No se sube nada y no hace falta cuenta. La reparación ocurre en tu navegador.',
    others: 'Otros casos',
    back: 'argano',
  },
};

export const CASES = [
  {
    id: 'photo-booth',
    slug: { en: 'photo-booth-video-wont-open', it: 'video-photo-booth-non-si-apre', es: 'video-photo-booth-no-se-abre' },
    en: {
      title: 'Photo Booth video won\'t open? Repair it free, without uploading it',
      description: 'A long Photo Booth recording that shows 0:00 or that QuickTime will not open still holds every frame. argano rebuilds its index in your browser, free and without uploading the video.',
      h1: 'Photo Booth video won\'t open',
      lead: 'The recording shows 0:00, or QuickTime says the file is not compatible. It usually happens to long recordings, and the video is almost always still there.',
      sections: [
        ['What happened to the file', [
          'A video file has two parts: the frames, written while you record, and an index that says where each frame starts, written once at the end. When Photo Booth stops before writing that index, the frames are all on disk but no player can find them.',
        ]],
        ['How to repair it', [
          'Find the file. Photo Booth keeps its recordings in Pictures, inside Photo Booth Library: right click it in Finder, choose Show Package Contents and open the Pictures folder. Copy the broken video somewhere else before doing anything.',
          'Record three seconds in Photo Booth on the same Mac, at the same size. Photo Booth does not write its settings inside the video, so argano reads them from this short clip.',
          'Open argano, drop the broken file, then the short clip, and press Repair. You get a new copy that plays. Your original is only read.',
        ]],
        ['What it cannot do', [
          'If Photo Booth stopped before the frames reached the disk, they are not in the file and no tool can bring them back. argano tells you how much of the file is media before it starts.',
        ]],
      ],
    },
    it: {
      title: 'Il video di Photo Booth non si apre? Riparalo gratis, senza caricarlo',
      description: 'Una registrazione lunga di Photo Booth che segna 0:00 o che QuickTime non apre contiene ancora tutti i fotogrammi. argano ne ricostruisce l\'indice nel browser, gratis e senza caricare il video.',
      h1: 'Il video di Photo Booth non si apre',
      lead: 'La registrazione segna 0:00, oppure QuickTime dice che il file non è compatibile. Succede di solito con le registrazioni lunghe, e il video quasi sempre è ancora lì.',
      sections: [
        ['Cosa è successo al file', [
          'Un file video ha due parti: i fotogrammi, scritti mentre registri, e un indice che dice dove comincia ciascuno, scritto una volta sola alla fine. Quando Photo Booth si ferma prima di scrivere l\'indice, i fotogrammi sono tutti sul disco ma nessun lettore li trova.',
        ]],
        ['Come ripararlo', [
          'Trova il file. Photo Booth tiene le registrazioni in Immagini, dentro la libreria di Photo Booth (Photo Booth Library): fai clic destro nel Finder, scegli Mostra contenuto pacchetto e apri la cartella Pictures. Copia il video rovinato da un\'altra parte prima di fare qualsiasi cosa.',
          'Registra tre secondi in Photo Booth sullo stesso Mac, alla stessa dimensione. Photo Booth non scrive le sue impostazioni dentro il video, quindi argano le legge da questa clip corta.',
          'Apri argano, trascina il file rovinato, poi la clip corta, e premi Ripara. Ottieni una copia nuova che si apre. L\'originale viene solo letto.',
        ]],
        ['Cosa non può fare', [
          'Se Photo Booth si è fermato prima che i fotogrammi arrivassero sul disco, nel file non ci sono e nessuno strumento può riportarli indietro. argano ti dice quanta parte del file è contenuto prima di cominciare.',
        ]],
      ],
    },
    es: {
      title: '¿El vídeo de Photo Booth no se abre? Repáralo gratis, sin subirlo',
      description: 'Una grabación larga de Photo Booth que marca 0:00 o que QuickTime no abre sigue teniendo todos los fotogramas. argano reconstruye su índice en el navegador, gratis y sin subir el vídeo.',
      h1: 'El vídeo de Photo Booth no se abre',
      lead: 'La grabación marca 0:00, o QuickTime dice que el archivo no es compatible. Suele pasar con grabaciones largas, y el vídeo casi siempre sigue ahí.',
      sections: [
        ['Qué le ha pasado al archivo', [
          'Un archivo de vídeo tiene dos partes: los fotogramas, que se escriben mientras grabas, y un índice que dice dónde empieza cada uno, que se escribe una sola vez al final. Cuando Photo Booth se para antes de escribir el índice, los fotogramas están todos en el disco pero ningún reproductor los encuentra.',
        ]],
        ['Cómo repararlo', [
          'Encuentra el archivo. Photo Booth guarda las grabaciones en Imágenes, dentro de la biblioteca de Photo Booth (Photo Booth Library): haz clic derecho en el Finder, elige Mostrar contenido del paquete y abre la carpeta Pictures. Copia el vídeo dañado a otro sitio antes de hacer nada.',
          'Graba tres segundos en Photo Booth en el mismo Mac, al mismo tamaño. Photo Booth no escribe sus ajustes dentro del vídeo, así que argano los lee de este clip corto.',
          'Abre argano, suelta el archivo dañado, luego el clip corto, y pulsa Reparar. Obtienes una copia nueva que se abre. Tu original solo se lee.',
        ]],
        ['Lo que no puede hacer', [
          'Si Photo Booth se paró antes de que los fotogramas llegaran al disco, no están en el archivo y ninguna herramienta puede recuperarlos. argano te dice qué parte del archivo es contenido antes de empezar.',
        ]],
      ],
    },
  },
  {
    id: 'moov-atom',
    slug: { en: 'moov-atom-not-found', it: 'moov-atom-not-found', es: 'moov-atom-not-found' },
    en: {
      title: '"moov atom not found": what it means and how to fix it free',
      description: 'The error means the MP4 or MOV lost its index, usually because the recording was cut short. argano rebuilds the moov atom from the frames, in your browser, free and without uploading the file.',
      h1: '"moov atom not found"',
      lead: 'VLC, ffmpeg or an editor refuses the file with this message. It means the index of the video is missing, and the frames are very often still in the file.',
      sections: [
        ['What the moov atom is', [
          'An MP4 or MOV file is made of boxes, which the format calls atoms. The mdat box holds the picture and the sound. The moov box is the index: where each frame starts, how long it lasts, in what order it plays. A recorder writes moov last, when you press stop. If the recording is cut short, moov is never written.',
        ]],
        ['Why the usual fixes do not work', [
          'Moving moov to the front with ffmpeg\'s faststart option only works when moov exists. Re-downloading helps only if the file broke in transit. When moov was never written, it has to be built again from the frames themselves.',
        ]],
        ['How to repair it', [
          'Open argano and drop the file. It reads the boxes and shows you how much of the file is media.',
          'If it asks for one, add a few seconds of another video shot with the same phone or camera, at the same setting. The settings that were never written are read from it.',
          'Press Repair. argano finds each frame, writes a new moov and checks the result, without encoding anything again. Your original is only read.',
        ]],
        ['What it cannot do', [
          'argano reads H.264 and H.265 video with AAC sound, in MP4, MOV and M4V. Media that never reached the disk cannot come back.',
        ]],
      ],
    },
    it: {
      title: '«moov atom not found»: cosa vuol dire e come risolverlo gratis',
      description: 'L\'errore vuol dire che l\'MP4 o il MOV ha perso l\'indice, di solito perché la registrazione si è interrotta. argano ricostruisce il moov atom dai fotogrammi, nel browser, gratis e senza caricare il file.',
      h1: '«moov atom not found»',
      lead: 'VLC, ffmpeg o un programma di montaggio rifiutano il file con questo messaggio. Vuol dire che manca l\'indice del video, e molto spesso i fotogrammi sono ancora nel file.',
      sections: [
        ['Cos\'è il moov atom', [
          'Un file MP4 o MOV è fatto di blocchi, che il formato chiama atom. Il blocco mdat contiene immagine e suono. Il blocco moov è l\'indice: dove comincia ogni fotogramma, quanto dura, in che ordine si vede. Un registratore scrive moov per ultimo, quando premi stop. Se la registrazione si interrompe, moov non viene mai scritto.',
        ]],
        ['Perché i rimedi soliti non funzionano', [
          'Spostare moov all\'inizio con l\'opzione faststart di ffmpeg funziona solo se moov esiste. Scaricare di nuovo il file aiuta solo se si è rovinato durante il trasferimento. Quando moov non è mai stato scritto, va ricostruito dai fotogrammi stessi.',
        ]],
        ['Come ripararlo', [
          'Apri argano e trascina il file. Legge i blocchi e ti mostra quanta parte del file è contenuto.',
          'Se te lo chiede, aggiungi qualche secondo di un altro video girato con lo stesso telefono o la stessa fotocamera, con la stessa impostazione. Le impostazioni mai scritte si leggono da lì.',
          'Premi Ripara. argano trova ogni fotogramma, scrive un moov nuovo e controlla il risultato, senza ricodificare niente. L\'originale viene solo letto.',
        ]],
        ['Cosa non può fare', [
          'argano legge video H.264 e H.265 con audio AAC, in MP4, MOV e M4V. Quello che non è mai arrivato sul disco non può tornare.',
        ]],
      ],
    },
    es: {
      title: '«moov atom not found»: qué significa y cómo arreglarlo gratis',
      description: 'El error significa que el MP4 o el MOV ha perdido su índice, normalmente porque la grabación se cortó. argano reconstruye el moov atom a partir de los fotogramas, en el navegador, gratis y sin subir el archivo.',
      h1: '«moov atom not found»',
      lead: 'VLC, ffmpeg o un editor rechazan el archivo con este mensaje. Significa que falta el índice del vídeo, y muy a menudo los fotogramas siguen en el archivo.',
      sections: [
        ['Qué es el moov atom', [
          'Un archivo MP4 o MOV está hecho de bloques, que el formato llama atoms. El bloque mdat contiene la imagen y el sonido. El bloque moov es el índice: dónde empieza cada fotograma, cuánto dura, en qué orden se ve. Una grabadora escribe moov al final, cuando pulsas stop. Si la grabación se corta, moov no se escribe nunca.',
        ]],
        ['Por qué los arreglos de siempre no funcionan', [
          'Mover moov al principio con la opción faststart de ffmpeg solo funciona si moov existe. Volver a descargar el archivo solo ayuda si se estropeó al transferirlo. Cuando moov nunca se escribió, hay que reconstruirlo a partir de los propios fotogramas.',
        ]],
        ['Cómo repararlo', [
          'Abre argano y suelta el archivo. Lee los bloques y te muestra qué parte del archivo es contenido.',
          'Si te lo pide, añade unos segundos de otro vídeo grabado con el mismo móvil o la misma cámara, con el mismo ajuste. Los ajustes que nunca se escribieron se leen de ahí.',
          'Pulsa Reparar. argano encuentra cada fotograma, escribe un moov nuevo y comprueba el resultado, sin recodificar nada. Tu original solo se lee.',
        ]],
        ['Lo que no puede hacer', [
          'argano lee vídeo H.264 y H.265 con sonido AAC, en MP4, MOV y M4V. Lo que nunca llegó al disco no puede volver.',
        ]],
      ],
    },
  },
  {
    id: 'cut-short',
    slug: { en: 'video-wont-play-after-recording-stopped', it: 'video-non-si-apre-registrazione-interrotta', es: 'video-no-se-abre-grabacion-cortada' },
    en: {
      title: 'Video won\'t play after the battery died or the camera stopped',
      description: 'A phone, camera or drone recording cut short by a dead battery, a full card or a crash keeps its frames. argano rebuilds the index in your browser, free and without uploading the video.',
      h1: 'The video won\'t play after the recording stopped',
      lead: 'The battery died, the card filled up, the app crashed or the phone ran out of space. The file is there, it has a size, and nothing will open it.',
      sections: [
        ['Why a full size file will not play', [
          'The recorder writes the frames as it goes and the index for last. Stopped early, it leaves a file that is almost all media with nothing that describes it. That is why the size looks right and every player refuses it.',
        ]],
        ['How to repair it', [
          'Copy the file to your computer first. A file on a card or a phone is repaired faster and more safely as a local copy.',
          'Open argano and drop it. It tells you what is wrong and how much of the file is media before doing anything.',
          'If it asks for one, add a few seconds of another video shot with the same phone, camera or drone, at the same resolution and frame rate. Then press Repair and save the copy that plays.',
        ]],
        ['What it cannot do', [
          'argano reads MP4, MOV and M4V with H.264 or H.265 video and AAC sound. Not MKV, not AVI, not a camera\'s own raw format. Frames that never reached the card cannot come back.',
        ]],
      ],
    },
    it: {
      title: 'Il video non si apre dopo che la batteria si è scaricata o la fotocamera si è fermata',
      description: 'Una registrazione di telefono, fotocamera o drone interrotta da una batteria scarica, una scheda piena o un crash conserva i fotogrammi. argano ricostruisce l\'indice nel browser, gratis e senza caricare il video.',
      h1: 'Il video non si apre dopo che la registrazione si è interrotta',
      lead: 'La batteria si è scaricata, la scheda si è riempita, l\'app si è chiusa o il telefono ha finito lo spazio. Il file c\'è, ha una dimensione, e niente lo apre.',
      sections: [
        ['Perché un file pieno non si apre', [
          'Il registratore scrive i fotogrammi man mano e l\'indice per ultimo. Se si ferma prima, lascia un file fatto quasi tutto di contenuto e senza niente che lo descriva. Per questo la dimensione sembra giusta e ogni lettore lo rifiuta.',
        ]],
        ['Come ripararlo', [
          'Copia prima il file sul computer. Un file su una scheda o su un telefono si ripara più in fretta e con meno rischi come copia locale.',
          'Apri argano e trascinalo. Ti dice cosa non va e quanta parte del file è contenuto prima di fare qualsiasi cosa.',
          'Se te lo chiede, aggiungi qualche secondo di un altro video girato con lo stesso telefono, fotocamera o drone, alla stessa risoluzione e frequenza. Poi premi Ripara e salva la copia che si apre.',
        ]],
        ['Cosa non può fare', [
          'argano legge MP4, MOV e M4V con video H.264 o H.265 e audio AAC. Non MKV, non AVI, non il formato raw di una fotocamera. I fotogrammi mai arrivati sulla scheda non possono tornare.',
        ]],
      ],
    },
    es: {
      title: 'El vídeo no se abre después de que se agotara la batería o se parara la cámara',
      description: 'Una grabación de móvil, cámara o dron cortada por una batería agotada, una tarjeta llena o un cierre inesperado conserva los fotogramas. argano reconstruye el índice en el navegador, gratis y sin subir el vídeo.',
      h1: 'El vídeo no se abre después de que se cortara la grabación',
      lead: 'Se agotó la batería, se llenó la tarjeta, la app se cerró o el móvil se quedó sin espacio. El archivo está, tiene tamaño, y nada lo abre.',
      sections: [
        ['Por qué un archivo con tamaño no se abre', [
          'La grabadora escribe los fotogramas sobre la marcha y el índice al final. Si se para antes, deja un archivo casi todo de contenido y sin nada que lo describa. Por eso el tamaño parece correcto y todos los reproductores lo rechazan.',
        ]],
        ['Cómo repararlo', [
          'Copia primero el archivo al ordenador. Un archivo en una tarjeta o en un móvil se repara más rápido y con menos riesgo como copia local.',
          'Abre argano y suéltalo. Te dice qué falla y qué parte del archivo es contenido antes de hacer nada.',
          'Si te lo pide, añade unos segundos de otro vídeo grabado con el mismo móvil, cámara o dron, con la misma resolución y frecuencia. Luego pulsa Reparar y guarda la copia que se abre.',
        ]],
        ['Lo que no puede hacer', [
          'argano lee MP4, MOV y M4V con vídeo H.264 o H.265 y sonido AAC. No MKV, no AVI, no el formato raw de una cámara. Los fotogramas que nunca llegaron a la tarjeta no pueden volver.',
        ]],
      ],
    },
  },
];
