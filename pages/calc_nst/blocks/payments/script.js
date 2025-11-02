/* =======================================================================
JS-логика для «Ввод оплат»
Секции:
  A) DOM и форматтеры.
  B) Утилиты: числа/даты/экранирование/+1 месяц/CSV-помощники.
  C) Таблица: добавление, редактирование, дублирование, удаление, сортировка, итоги.
  D) Экспорт: CSV (Excel/Numbers), XML, Text(JSONL).
  E) Импорт: CSV/TSV, XML, Text(JSONL).
  F) Обработчики и инициализация.
======================================================================= */
(function(){
  /* ===================== A) DOM и форматтеры ======================== */
  var root = document.querySelector('.elegso-pay');
  var locale = (root && root.dataset && root.dataset.locale) ? root.dataset.locale : (navigator.language || 'ru-RU');
  var moneyFmt = new Intl.NumberFormat(locale, { minimumFractionDigits:2, maximumFractionDigits:2 });

  // Поля ввода панели
  var dateEl = document.getElementById('pay_date');
  var amtEl  = document.getElementById('pay_amount');
  var comEl  = document.getElementById('pay_comment');

  // Кнопки панели
  var addBtn   = document.getElementById('pay_add');
  var sortBtn  = document.getElementById('pay_sort');
  var clearBtn = document.getElementById('pay_clear');

  // «Данные»: меню и инпуты
  var dataBtn   = document.getElementById('pay_data_btn');
  var dataMenu  = document.getElementById('pay_data_menu');
  var fileCsvIn = document.getElementById('pay_file_csv');
  var fileXmlIn = document.getElementById('pay_file_xml');
  var fileTxtIn = document.getElementById('pay_file_txt');

  // Таблица
  var table  = document.getElementById('pay_table');
  var tbody  = table.querySelector('tbody');
  var thDate = document.getElementById('pay_th_date');
  var sumEl  = document.getElementById('pay_sum');

  // Текущее направление сортировки по дате (true — по возрастанию)
  var currentAsc = true;

  /* ===================== B) Утилиты ================================= */
  function sanitizeNumber(str){ if(typeof str!=='string') return str; return str.replace(',', '.').replace(/\s+/g,'').trim(); }
  function parseAmountToCents(input){ if(input===''||input==null) return null; var n=Number(sanitizeNumber(String(input))); if(Number.isNaN(n)) return null; return Math.round(n*100); }
  function formatCents(c){ return moneyFmt.format((c||0)/100); }

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
      var c=Number(tr.children[2].getAttribute('data-amount')||0)||0; sum+=c;
    });
    sumEl.textContent = formatCents(sum);
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

  // Режим просмотра
  function setRowToView(tr, data){
    tr.setAttribute('data-date', data.dateISO);
    tr.children[1].textContent = formatDateHuman(data.dateISO);

    var amtCell=tr.children[2];
    amtCell.className='num';
    amtCell.setAttribute('data-amount', String(data.cents||0));
    amtCell.textContent = formatCents(data.cents||0);

    tr.children[3].textContent = data.comment||'';
    tr.children[4].innerHTML =
      '<div class="row-actions">'+
        '<button type="button" class="mini" data-action="edit">Изменить</button>'+
        '<button type="button" class="mini" data-action="month">Месяц</button>'+
        '<button type="button" class="mini" data-action="delete">Удалить</button>'+
      '</div>';
  }

  // Режим редактирования
  function setRowToEdit(tr){
    var dateISO=tr.getAttribute('data-date')||'';
    var cents=Number(tr.children[2].getAttribute('data-amount')||0);
    var comment=tr.children[3].textContent||'';

    tr.children[1].innerHTML = '<input type="date" class="inline-input" data-field="date" value="'+dateISO+'" />';
    tr.children[2].innerHTML = '<input type="text" class="inline-input num" data-field="amount" inputmode="decimal" value="'+((cents/100).toFixed(2).replace('.',','))+'" />';
    tr.children[3].innerHTML = '<input type="text" class="inline-input" data-field="comment" value="'+(comment.replace(/"/g,'&quot;'))+'" />';

    tr.children[4].innerHTML =
      '<div class="row-actions">'+
        '<button type="button" class="mini" data-action="save">Сохранить</button>'+
        '<button type="button" class="mini" data-action="delete">Удалить</button>'+
      '</div>';
  }

  // Считать значения из инлайн-редактора
  function readEditValues(tr){
    var dateInput=tr.querySelector('input[data-field="date"]');
    var amtInput =tr.querySelector('input[data-field="amount"]');
    var comInput =tr.querySelector('input[data-field="comment"]');

    var dateISO=dateInput?dateInput.value:'';
    var cents=parseAmountToCents(amtInput?amtInput.value:'');
    var comment=comInput?(comInput.value||'').trim():'';

    if(!dateISO){ alert('Пожалуйста, укажите дату.'); return null; }
    return { dateISO:dateISO, cents:(cents==null?0:cents), comment:comment };
  }

  // Добавление строки из панели ввода
  function addRow(){
    var dateVal=dateEl.value;
    var cents=parseAmountToCents(amtEl.value);
    var comment=(comEl.value||'').trim();

    if(!dateVal){ alert('Пожалуйста, выберите дату.'); return; }
    if((amtEl.value===''||isNaN(Number(sanitizeNumber(amtEl.value)))) && comment===''){
      alert('Введите сумму в «Оплачено» или добавьте комментарий.');
      return;
    }
    if(cents==null) cents=0;

    var tr=document.createElement('tr'); tr.setAttribute('data-date', dateVal);
    tr.innerHTML =
      '<td>•</td>'+
      '<td class="no-wrap">'+formatDateHuman(dateVal)+'</td>'+
      '<td class="num" data-amount="'+cents+'">'+formatCents(cents)+'</td>'+
      '<td>'+(comment.replace(/</g,'&lt;'))+'</td>'+
      '<td><div class="row-actions">'+
        '<button type="button" class="mini" data-action="edit">Изменить</button>'+
        '<button type="button" class="mini" data-action="month">Месяц</button>'+
        '<button type="button" class="mini" data-action="delete">Удалить</button>'+
      '</div></td>';

    tbody.appendChild(tr);
    sortRows(currentAsc);
    recalcTotals();

    // Очистить форму
    dateEl.value=''; amtEl.value=''; comEl.value='';
  }

  function toggleSort(){ currentAsc=!currentAsc; sortRows(currentAsc); updateSortLabel(); }
  function clearTable(){ tbody.innerHTML=''; recalcTotals(); updateSortLabel(); }
  function deleteRow(btn){ var tr=btn.closest('tr'); if(!tr) return; tr.remove(); sortRows(currentAsc); recalcTotals(); }
  function duplicateNextMonth(btn){
    var tr=btn.closest('tr'); if(!tr) return;
    var dateISO=tr.getAttribute('data-date')||''; if(!dateISO) return;
    var newISO=addMonthsISO(dateISO,1);
    var cents=Number(tr.children[2].getAttribute('data-amount')||0);
    var comment=tr.children[3].textContent||'';

    var ntr=document.createElement('tr'); ntr.setAttribute('data-date', newISO);
    ntr.innerHTML =
      '<td>•</td>'+
      '<td class="no-wrap">'+formatDateHuman(newISO)+'</td>'+
      '<td class="num" data-amount="'+cents+'">'+formatCents(cents)+'</td>'+
      '<td>'+(comment.replace(/</g,'&lt;'))+'</td>'+
      '<td><div class="row-actions">'+
        '<button type="button" class="mini" data-action="edit">Изменить</button>'+
        '<button type="button" class="mini" data-action="month">Месяц</button>'+
        '<button type="button" class="mini" data-action="delete">Удалить</button>'+
      '</div></td>';
    tbody.appendChild(ntr);
    sortRows(currentAsc); recalcTotals();
  }

  /* ===================== D) Экспорт ================================= */
  // Собрать текущие строки таблицы в массив
  function collectRows(){
    var rows=[]; Array.prototype.forEach.call(tbody.querySelectorAll('tr'), function(tr){
      rows.push({
        dateISO: tr.getAttribute('data-date')||'',
        cents  : Number(tr.children[2].getAttribute('data-amount')||0)||0,
        comment: tr.children[3].textContent||''
      });
    }); return rows;
  }

  // Скачивание файла
  function downloadBlob(content, mime, filename){
    var blob=new Blob([content], {type: mime+';charset=utf-8'});
    var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename;
    document.body.appendChild(a); a.click(); setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  // Экспорт в Excel (CSV): UTF-8 BOM, ;, dd.mm.yyyy, десятичная запятая
  function exportToCSV(){
    var rows = collectRows();
    var delim = ';';
    var lines = [];

    // Заголовки
    lines.push(['№','Дата','Оплачено','Комментарий'].join(delim));

    // Данные
    rows.forEach(function(r, i){
      var num    = String(i+1);
      var dateRu = isoToRu(r.dateISO);
      var amount = ((r.cents||0)/100).toFixed(2).replace('.', ',');
      var comm   = csvEscape(r.comment, delim);
      lines.push([num, dateRu, amount, comm].join(delim));
    });

    // Строка «Итого»
    var sumCents = rows.reduce(function(s,r){ return s+(r.cents||0); },0);
    var sumStr = (sumCents/100).toFixed(2).replace('.', ',');
    lines.push(['', 'Итого', sumStr, ''].join(delim));

    var csvContent = '\uFEFF' + lines.join('\r\n'); // BOM
    downloadBlob(csvContent, 'text/csv', 'Оплаты.csv');
  }

  // Экспорт в XML
  function exportToXML(){
    var rows=collectRows();
    var xml = '<?xml version="1.0" encoding="UTF-8"?><rows kind="payments">';
    rows.forEach(function(r){
      xml+='<row><date>'+r.dateISO+'</date><amount_cents>'+ (r.cents||0) +'</amount_cents><comment>'+escXml(r.comment||'')+'</comment></row>';
    });
    xml+='</rows>';
    downloadBlob(xml, 'application/xml', 'Оплаты.xml');
  }

  // Экспорт в текст (JSON Lines)
  function exportToText(){
    var rows=collectRows();
    var lines = rows.map(function(r){
      return JSON.stringify({date:r.dateISO, amount_cents:(r.cents||0), comment:r.comment||''});
    }).join('\n');
    downloadBlob(lines, 'text/plain', 'Оплаты.jsonl');
  }

  /* ===================== E) Импорт ================================== */
  // Импорт из CSV/TSV (поддержка 4 колонок с № и 3 без №; пропускаем «Итого»)
  function importFromCsvTsv(file){
    var reader=new FileReader();
    reader.onload=function(e){
      var text=e.target.result||'';
      var lines=text.split(/\r?\n/).filter(function(l){ return l.trim()!==''; });
      if(!lines.length) return;

      // Пропускаем заголовок, если видим «дата» и «оплачено»
      var idx=0, header=(lines[0]||'').toLowerCase();
      if(/дата/.test(header) && /оплачено/.test(header)) idx=1;

      for(var i=idx; i<lines.length; i++){
        var line=lines[i];
        if(/итого/i.test(line)) continue; // строку «Итого» пропускаем

        var delim = (line.indexOf(';')>-1)?';':(line.indexOf('\t')>-1)?'\t':',';
        var cells = parseCsvLine(line, delim);
        if(!cells.length) continue;

        var dateCell='', amountCell='', commentCell='';
        // Вариант 4 колонки: №;Дата;Оплачено;Комментарий
        if(cells.length>=4 && (isRuDate(cells[1].trim()) || isIsoDate(cells[1].trim()))){
          dateCell    = cells[1].trim();
          amountCell  = cells[2].trim();
          commentCell = cells[3] != null ? cells[3].trim() : '';
        }
        // Вариант 3 колонки: Дата;Оплачено;Комментарий
        else if(cells.length>=3 && (isRuDate(cells[0].trim()) || isIsoDate(cells[0].trim()))){
          dateCell    = cells[0].trim();
          amountCell  = cells[1].trim();
          commentCell = cells[2] != null ? cells[2].trim() : '';
        } else {
          continue; // не наша строка
        }

        var dateISO = parseDateAuto(dateCell);
        var cents = parseAmountToCents((amountCell||'').replace(',', '.'));
        if(dateISO){
          appendImportedRow({dateISO:dateISO, cents:(cents==null?0:cents), comment:commentCell});
        }
      }
      sortRows(currentAsc); recalcTotals();
    };
    reader.readAsText(file, 'utf-8');
  }

  // Импорт из XML
  function importFromXMLFile(file){
    var reader=new FileReader();
    reader.onload=function(e){
      var xml=e.target.result||'';
      var dom=new DOMParser().parseFromString(xml, 'application/xml');
      var rows=dom.querySelectorAll('row');
      rows.forEach(function(node){
        var d=(node.querySelector('date')||{}).textContent||'';
        var centsTxt=(node.querySelector('amount_cents')||{}).textContent||'';
        var cmt=(node.querySelector('comment')||{}).textContent||'';
        var cents = /^\d+$/.test(centsTxt) ? Number(centsTxt) : Math.round((Number(centsTxt)||0)*100);
        if(d){ appendImportedRow({dateISO:d, cents:cents, comment:cmt}); }
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
          if(o && o.date){ appendImportedRow({dateISO:o.date, cents:Number(o.amount_cents||0), comment:o.comment||''}); }
        }catch(err){ /* пропускаем невалидную строку */ }
      });
      sortRows(currentAsc); recalcTotals();
    };
    reader.readAsText(file, 'utf-8');
  }

  // Создание строки из импортируемых данных
  function appendImportedRow(r){
    var tr=document.createElement('tr'); tr.setAttribute('data-date', r.dateISO);
    tr.innerHTML =
      '<td>•</td>'+
      '<td class="no-wrap">'+formatDateHuman(r.dateISO)+'</td>'+
      '<td class="num" data-amount="'+(r.cents||0)+'">'+formatCents(r.cents||0)+'</td>'+
      '<td>'+( (r.comment||'').replace(/</g,'&lt;') )+'</td>'+
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
  [dateEl, amtEl, comEl].forEach(function(el){
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
