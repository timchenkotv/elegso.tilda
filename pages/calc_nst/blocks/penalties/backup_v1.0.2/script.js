/* =======================================================================
JS-логика для «Ввод неустойки»
Секции:
  A) DOM и форматтеры.
  B) Утилиты: числа/даты/экранирование/+1 месяц/CSV-помощники.
  C) Таблица: добавление, редактирование (включая select), дублирование, удаление,
     сортировка, итоги.
  D) Экспорт: CSV (Excel/Numbers), XML, Text(JSONL).
  E) Импорт: CSV/TSV, XML, Text(JSONL).
  F) Обработчики и инициализация.
======================================================================= */
(function(){
  /* ===================== A) DOM и форматтеры ======================== */
  var root = document.querySelector('.elegso-pen');
  var locale = (root && root.dataset && root.dataset.locale) ? root.dataset.locale : (navigator.language || 'ru-RU');
  // Два знака и разделение тысяч — нейтральный формат для "числа"
  var numFmt = new Intl.NumberFormat(locale, { minimumFractionDigits:2, maximumFractionDigits:2 });

  // Поля ввода панели
  var dateEl = document.getElementById('pen_date');
  var valEl  = document.getElementById('pen_value');
  var meaEl  = document.getElementById('pen_measure');

  // Кнопки панели
  var addBtn   = document.getElementById('pen_add');
  var sortBtn  = document.getElementById('pen_sort');
  var clearBtn = document.getElementById('pen_clear');

  // «Данные»: меню и инпуты
  var dataBtn   = document.getElementById('pen_data_btn');
  var dataMenu  = document.getElementById('pen_data_menu');
  var fileCsvIn = document.getElementById('pen_file_csv');
  var fileXmlIn = document.getElementById('pen_file_xml');
  var fileTxtIn = document.getElementById('pen_file_txt');

  // Таблица
  var table  = document.getElementById('pen_table');
  var tbody  = table.querySelector('tbody');
  var thDate = document.getElementById('pen_th_date');
  var sumEl  = document.getElementById('pen_sum');

  // Текущее направление сортировки по дате (true — по возрастанию)
  var currentAsc = true;

  // Фиксированный набор измерений (для единообразия между вводом/редактированием/импортом)
  var MEASURE_OPTIONS = [
    '% за каждый день',
    '% за каждый рабочий день',
    '% в год'
  ];

  /* ===================== B) Утилиты ================================= */
  function sanitizeNumber(str){ if(typeof str!=='string') return str; return str.replace(',', '.').replace(/\s+/g,'').trim(); }
  // Для консистентности с другими блоками используем "сотые" (как центы): value100 = Math.round(value * 100)
  function parseToHundredths(input){ if(input===''||input==null) return null; var n=Number(sanitizeNumber(String(input))); if(Number.isNaN(n)) return null; return Math.round(n*100); }
  function formatHundredths(v100){ return numFmt.format((v100||0)/100); }

  function formatDateHuman(iso){ var p=iso.split('-'); return p.length===3? (p[2]+'.'+p[1]+'.'+p[0]) : ''; }
  function isIsoDate(s){ return /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function isRuDate(s){ return /^\d{2}\.\d{2}\.\d{4}$/.test(s); }
  function ruToIso(s){ var p=s.split('.'); return p[2]+'-'+p[1]+'-'+p[0]; }
  function isoToRu(s){ var p=s.split('-'); return p[2]+'.'+p[1]+'.'+p[0]; }
  function parseDateAuto(s){ s=(s||'').trim(); if(isIsoDate(s)) return s; if(isRuDate(s)) return ruToIso(s); return ''; }

  function escXml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // +1 календарный месяц (корректно для концов месяцев)
  function addMonthsISO(iso, months){
    var p=iso.split('-'); if(p.length!==3) return iso;
    var y=parseInt(p[0],10), m=parseInt(p[1],10), d=parseInt(p[2],10);
    var tm=m-1+months, ny=y+Math.floor(tm/12), nm=(tm%12+12)%12+1;
    var dim=new Date(ny,nm,0).getDate(), nd=Math.min(d,dim);
    return ny+'-'+String(nm).padStart(2,'0')+'-'+String(nd).padStart(2,'0');
  }

  // CSV helpers
  function csvEscape(s, delim){ var t=String(s==null?'':s).replace(/"/g,'""'); return (/[\"\r\n]/.test(t) || t.indexOf(delim)>-1) ? ('"'+t+'"') : t; }
  function parseCsvLine(line, delim){
    var out=[], cur='', inQ=false;
    for(var i=0;i<line.length;i++){
      var ch=line[i];
      if(ch==='\"'){ if(inQ && line[i+1]==='\"'){ cur+='\"'; i++; } else { inQ=!inQ; } }
      else if(ch===delim && !inQ){ out.push(cur); cur=''; }
      else { cur+=ch; }
    }
    out.push(cur); return out;
  }

  /* ===================== C) Таблица ================================= */
  function reindexRows(){
    Array.prototype.forEach.call(tbody.querySelectorAll('tr'), function(tr, idx){
      var c0=tr.children[0]; if(c0){ c0.textContent=String(idx+1); }
    });
  }
  function recalcTotals(){
    var sum=0;
    Array.prototype.forEach.call(tbody.querySelectorAll('tr'), function(tr){
      var v=Number(tr.children[2].getAttribute('data-val100')||0)||0; sum+=v;
    });
    sumEl.textContent = formatHundredths(sum);
  }
  function sortRows(asc){
    var rows=Array.prototype.slice.call(tbody.querySelectorAll('tr'));
    rows.sort(function(a,b){
      var da=a.getAttribute('data-date')||'', db=b.getAttribute('data-date')||'';
      if(da<db) return asc?-1:1; if(da>db) return asc?1:-1; return 0;
    });
    rows.forEach(function(r){ tbody.appendChild(r); });
    reindexRows();
  }
  function updateSortLabel(){
    sortBtn.textContent = currentAsc ? 'Сортировка: по дате ↑' : 'Сортировка: по дате ↓';
    sortBtn.setAttribute('aria-pressed', currentAsc ? 'true' : 'false');
  }

  // Отрисовать строку в «режиме просмотра»
  function setRowToView(tr, data){
    tr.setAttribute('data-date', data.dateISO);
    tr.children[1].textContent = formatDateHuman(data.dateISO);

    var vCell=tr.children[2];
    vCell.className='num';
    vCell.setAttribute('data-val100', String(data.val100||0));
    vCell.textContent = formatHundredths(data.val100||0);

    tr.children[3].textContent = data.measure || '';

    tr.children[4].innerHTML =
      '<div class="row-actions">'+
        '<button type="button" class="mini" data-action="edit">Изменить</button>'+
        '<button type="button" class="mini" data-action="month">Месяц</button>'+
        '<button type="button" class="mini" data-action="delete">Удалить</button>'+
      '</div>';
  }

  // Перевести строку в «режим редактирования»
  function setRowToEdit(tr){
    var dateISO = tr.getAttribute('data-date')||'';
    var val100  = Number(tr.children[2].getAttribute('data-val100')||0);
    var measure = tr.children[3].textContent||'';

    tr.children[1].innerHTML = '<input type="date" class="inline-input" data-field="date" value="'+dateISO+'" />';
    tr.children[2].innerHTML = '<input type="text" class="inline-input num" data-field="value" inputmode="decimal" value="'+((val100/100).toFixed(2).replace('.',','))+'" />';

    // Селект «Измерение» с теми же вариантами
    var sel = '<select class="inline-input" data-field="measure">';
    MEASURE_OPTIONS.forEach(function(opt){
      var selAttr = (opt===measure)?' selected':'';
      sel += '<option value="'+opt.replace(/"/g,'&quot;')+'"'+selAttr+'>'+opt+'</option>';
    });
    sel += '</select>';
    tr.children[3].innerHTML = sel;

    tr.children[4].innerHTML =
      '<div class="row-actions">'+
        '<button type="button" class="mini" data-action="save">Сохранить</button>'+
        '<button type="button" class="mini" data-action="delete">Удалить</button>'+
      '</div>';
  }

  // Считать значения из инлайн-редактора и проверить обязательные поля
  function readEditValues(tr){
    var dateInput = tr.querySelector('input[data-field="date"]');
    var valInput  = tr.querySelector('input[data-field="value"]');
    var meaInput  = tr.querySelector('select[data-field="measure"]');

    var dateISO = dateInput?dateInput.value:'';
    var val100  = parseToHundredths(valInput?valInput.value:'');
    var measure = meaInput?meaInput.value:'';

    if(!dateISO){ alert('Пожалуйста, укажите дату.'); return null; }
    if(val100==null && !measure){ alert('Введите «Неустойка» или выберите «Измерение».'); return null; }
    if(val100==null) val100=0;

    return { dateISO:dateISO, val100:val100, measure:measure };
  }

  // Добавление строки из панели ввода
  function addRow(){
    var dateVal = dateEl.value;
    var val100  = parseToHundredths(valEl.value);
    var measure = meaEl.value || '';

    if(!dateVal){ alert('Пожалуйста, выберите дату.'); return; }
    if((valEl.value===''||isNaN(Number(sanitizeNumber(valEl.value)))) && !measure){
      alert('Введите значение в «Неустойка» или выберите «Измерение».');
      return;
    }
    if(val100==null) val100=0;

    var tr=document.createElement('tr'); tr.setAttribute('data-date', dateVal);
    tr.innerHTML =
      '<td>•</td>'+
      '<td class="no-wrap">'+formatDateHuman(dateVal)+'</td>'+
      '<td class="num" data-val100="'+val100+'">'+formatHundredths(val100)+'</td>'+
      '<td>'+measure+'</td>'+
      '<td><div class="row-actions">'+
        '<button type="button" class="mini" data-action="edit">Изменить</button>'+
        '<button type="button" class="mini" data-action="month">Месяц</button>'+
        '<button type="button" class="mini" data-action="delete">Удалить</button>'+
      '</div></td>';

    tbody.appendChild(tr);
    sortRows(currentAsc);
    recalcTotals();

    // Очистить форму
    dateEl.value=''; valEl.value=''; meaEl.value = MEASURE_OPTIONS[0];
  }

  // Переключатель сортировки
  function toggleSort(){ currentAsc=!currentAsc; sortRows(currentAsc); updateSortLabel(); }

  // Очистить всю таблицу
  function clearTable(){ tbody.innerHTML=''; recalcTotals(); updateSortLabel(); }

  // Удаление строки
  function deleteRow(btn){ var tr=btn.closest('tr'); if(!tr) return; tr.remove(); sortRows(currentAsc); recalcTotals(); }

  // Дублировать на следующий календарный месяц
  function duplicateNextMonth(btn){
    var tr=btn.closest('tr'); if(!tr) return;
    var dateISO=tr.getAttribute('data-date')||''; if(!dateISO) return;
    var newISO=addMonthsISO(dateISO,1);
    var val100 = Number(tr.children[2].getAttribute('data-val100')||0);
    var measure= tr.children[3].textContent||'';

    var ntr=document.createElement('tr'); ntr.setAttribute('data-date', newISO);
    ntr.innerHTML =
      '<td>•</td>'+
      '<td class="no-wrap">'+formatDateHuman(newISO)+'</td>'+
      '<td class="num" data-val100="'+val100+'">'+formatHundredths(val100)+'</td>'+
      '<td>'+measure+'</td>'+
      '<td><div class="row-actions">'+
        '<button type="button" class="mini" data-action="edit">Изменить</button>'+
        '<button type="button" class="mini" data-action="month">Месяц</button>'+
        '<button type="button" class="mini" data-action="delete">Удалить</button>'+
      '</div></td>';
    tbody.appendChild(ntr);
    sortRows(currentAsc); recalcTotals();
  }

  /* ===================== D) Экспорт ================================= */
  // Собрать массив текущих строк
  function collectRows(){
    var rows=[]; Array.prototype.forEach.call(tbody.querySelectorAll('tr'), function(tr){
      rows.push({
        dateISO : tr.getAttribute('data-date')||'',
        val100  : Number(tr.children[2].getAttribute('data-val100')||0)||0,
        measure : tr.children[3].textContent||''
      });
    }); return rows;
  }

  // Скачивание файла
  function downloadBlob(content, mime, filename){
    var blob=new Blob([content], {type: mime+';charset=utf-8'});
    var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename;
    document.body.appendChild(a); a.click(); setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  // Экспорт CSV: UTF-8 BOM, ;, dd.mm.yyyy, десятичная запятая
  function exportToCSV(){
    var rows = collectRows();
    var delim = ';';
    var lines = [];

    // Заголовки
    lines.push(['№','Дата','Неустойка','Измерение'].join(delim));

    // Данные
    rows.forEach(function(r, i){
      var num    = String(i+1);
      var dateRu = isoToRu(r.dateISO);
      var valStr = ((r.val100||0)/100).toFixed(2).replace('.', ',');
      var meas   = csvEscape(r.measure, delim);
      lines.push([num, dateRu, valStr, meas].join(delim));
    });

    // Строка «Итого»
    var sum100 = rows.reduce(function(s,r){ return s+(r.val100||0); },0);
    var sumStr = (sum100/100).toFixed(2).replace('.', ',');
    lines.push(['', 'Итого', sumStr, ''].join(delim));

    var csvContent = '\uFEFF' + lines.join('\r\n'); // BOM
    downloadBlob(csvContent, 'text/csv', 'Неустойки.csv');
  }

  // Экспорт XML
  function exportToXML(){
    var rows=collectRows();
    var xml = '<?xml version="1.0" encoding="UTF-8"?><rows kind="penalties">';
    rows.forEach(function(r){
      xml+='<row><date>'+r.dateISO+'</date><value_100>'+ (r.val100||0) +'</value_100><measurement>'+escXml(r.measure||'')+'</measurement></row>';
    });
    xml+='</rows>';
    downloadBlob(xml, 'application/xml', 'Неустойки.xml');
  }

  // Экспорт в текст (JSON Lines)
  function exportToText(){
    var rows=collectRows();
    var lines = rows.map(function(r){
      return JSON.stringify({date:r.dateISO, value_100:(r.val100||0), measurement:r.measure||''});
    }).join('\n');
    downloadBlob(lines, 'text/plain', 'Неустойки.jsonl');
  }

  /* ===================== E) Импорт ================================== */
  // Импорт из CSV/TSV:
  //   4 колонки: №;Дата;Неустойка;Измерение
  //   3 колонки: Дата;Неустойка;Измерение
  // Пропускаем строку «Итого».
  function importFromCsvTsv(file){
    var reader=new FileReader();
    reader.onload=function(e){
      var text=e.target.result||'';
      var lines=text.split(/\r?\n/).filter(function(l){ return l.trim()!==''; });
      if(!lines.length) return;

      // Пропускаем заголовок, если видим «дата» и «неустойка»
      var idx=0, header=(lines[0]||'').toLowerCase();
      if(/дата/.test(header) && /неустойка/.test(header)) idx=1;

      for(var i=idx; i<lines.length; i++){
        var line=lines[i];
        if(/итого/i.test(line)) continue; // строку «Итого» пропускаем

        var delim = (line.indexOf(';')>-1)?';':(line.indexOf('\t')>-1)?'\t':',';
        var cells = parseCsvLine(line, delim);
        if(!cells.length) continue;

        var dateCell='', valueCell='', measCell='';
        // Вариант 4 колонки (с №)
        if(cells.length>=4 && (isRuDate(cells[1].trim()) || isIsoDate(cells[1].trim()))){
          dateCell  = cells[1].trim();
          valueCell = cells[2].trim();
          measCell  = cells[3] != null ? cells[3].trim() : '';
        }
        // Вариант 3 колонки (без №)
        else if(cells.length>=3 && (isRuDate(cells[0].trim()) || isIsoDate(cells[0].trim()))){
          dateCell  = cells[0].trim();
          valueCell = cells[1].trim();
          measCell  = cells[2] != null ? cells[2].trim() : '';
        } else {
          continue; // не наша строка
        }

        var dateISO = parseDateAuto(dateCell);
        var val100  = parseToHundredths((valueCell||'').replace(',', '.'));
        var measure = measCell;

        if(dateISO){
          appendImportedRow({dateISO:dateISO, val100:(val100==null?0:val100), measure:measure});
        }
      }
      sortRows(currentAsc); recalcTotals();
    };
    reader.readAsText(file, 'utf-8');
  }

  // Импорт XML
  function importFromXMLFile(file){
    var reader=new FileReader();
    reader.onload=function(e){
      var xml=e.target.result||'';
      var dom=new DOMParser().parseFromString(xml, 'application/xml');
      var rows=dom.querySelectorAll('row');
      rows.forEach(function(node){
        var d=(node.querySelector('date')||{}).textContent||'';
        var vTxt=(node.querySelector('value_100')||{}).textContent||'';
        var m =(node.querySelector('measurement')||{}).textContent||'';
        var v100 = /^\d+$/.test(vTxt) ? Number(vTxt) : Math.round((Number(vTxt)||0)*100);
        if(d){ appendImportedRow({dateISO:d, val100:v100, measure:m}); }
      });
      sortRows(currentAsc); recalcTotals();
    };
    reader.readAsText(file, 'utf-8');
  }

  // Импорт из текстового формата (JSON Lines)
  function importFromTextFile(file){
    var reader=new FileReader();
    reader.onload=function(e){
      var txt=e.target.result||'';
      txt.split(/\r?\n/).forEach(function(line){
        line=line.trim(); if(!line) return;
        try{
          var o=JSON.parse(line);
          if(o && o.date){ appendImportedRow({dateISO:o.date, val100:Number(o.value_100||0), measure:o.measurement||''}); }
        }catch(err){ /* пропускаем невалидную строку */ }
      });
      sortRows(currentAsc); recalcTotals();
    };
    reader.readAsText(file, 'utf-8');
  }

  // Создание строки из импортируемых данных
  function appendImportedRow(r){
    // Нормализуем измерение к одному из предопределённых (если возможно)
    var measure = MEASURE_OPTIONS.indexOf(r.measure)>=0 ? r.measure : r.measure;
    var tr=document.createElement('tr'); tr.setAttribute('data-date', r.dateISO);
    tr.innerHTML =
      '<td>•</td>'+
      '<td class="no-wrap">'+formatDateHuman(r.dateISO)+'</td>'+
      '<td class="num" data-val100="'+(r.val100||0)+'">'+formatHundredths(r.val100||0)+'</td>'+
      '<td>'+measure+'</td>'+
      '<td><div class="row-actions">'+
        '<button type="button" class="mini" data-action="edit">Изменить</button>'+
        '<button type="button" class="mini" data-action="month">Месяц</button>'+
        '<button type="button" class="mini" data-action="delete">Удалить</button>'+
      '</div></td>';
    tbody.appendChild(tr);
  }

  /* ===================== F) Обработчики и init ======================= */
  addBtn .addEventListener('click', addRow);
  sortBtn.addEventListener('click', toggleSort);
  thDate .addEventListener('click', toggleSort);
  clearBtn.addEventListener('click', clearTable);

  // Кнопки внутри строк
  tbody.addEventListener('click', function(e){
    var t=e.target; if(!t||t.tagName!=='BUTTON') return;
    var a=t.getAttribute('data-action');
    if(a==='delete')      deleteRow(t);
    else if(a==='edit')   setRowToEdit(t.closest('tr'));
    else if(a==='save'){  var tr=t.closest('tr'); var data=readEditValues(tr); if(!data) return; setRowToView(tr,data); sortRows(currentAsc); recalcTotals(); }
    else if(a==='month')  duplicateNextMonth(t);
  });

  // Enter = «Добавить» в панели; Enter = «Сохранить» в режиме редактирования
  [dateEl, valEl, meaEl].forEach(function(el){
    el.addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); addRow(); } });
  });
  tbody.addEventListener('keydown', function(e){
    if(e.key==='Enter'){
      var tr=e.target&&e.target.closest?e.target.closest('tr'):null;
      var btn=tr?tr.querySelector('button[data-action="save"]'):null;
      if(btn){ e.preventDefault(); btn.click(); }
    }
  });

  // Меню «Данные» открыть/закрыть
  dataBtn.addEventListener('click', function(){
    var open = !dataMenu.hasAttribute('hidden');
    if(open){ dataMenu.setAttribute('hidden',''); dataBtn.setAttribute('aria-expanded','false'); }
    else    { dataMenu.removeAttribute('hidden'); dataBtn.setAttribute('aria-expanded','true'); }
  });
  // Клик вне меню/по пункту — закрытие
  document.addEventListener('click', function(e){
    if(!root.contains(e.target) || e.target.closest('.data-menu .menu-item')){
      dataMenu.setAttribute('hidden',''); dataBtn.setAttribute('aria-expanded','false');
    }
  }, true);

  // Обработка команд меню «Данные»
  dataMenu.addEventListener('click', function(e){
    var btn=e.target.closest('.menu-item'); if(!btn) return;
    var cmd=btn.getAttribute('data-cmd');
    if(cmd==='export-excel') exportToCSV();
    else if(cmd==='import-excel') fileCsvIn.click();
    else if(cmd==='export-xml')   exportToXML();
    else if(cmd==='import-xml')   fileXmlIn.click();
    else if(cmd==='export-text')  exportToText();
    else if(cmd==='import-text')  fileTxtIn.click();
  });

  // Файловые инпуты
  fileCsvIn.addEventListener('change', function(){ var f=this.files&&this.files[0]; if(f){ importFromCsvTsv(f); this.value=''; } });
  fileXmlIn.addEventListener('change', function(){ var f=this.files&&this.files[0]; if(f){ importFromXMLFile(f); this.value=''; } });
  fileTxtIn.addEventListener('change', function(){ var f=this.files&&this.files[0]; if(f){ importFromTextFile(f); this.value=''; } });

  // Подпись сортировки
  updateSortLabel();
})();
