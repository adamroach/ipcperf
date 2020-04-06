#!/usr/bin/env node

const output_csv = 'digest.csv';
const output_json = 'digest.json';
const graphDirectory = 'graphs';

// Modules
const fs = require('fs');
const readline = require('readline');

// Globals
let logLineCount = 0;
let log = [];
let threadName = {};
let processName = {};
let firstLogTimestamp = undefined;

const colors = ['red','orange','brown','green','blue','purple'];

(async function main() {

  let profile = undefined;

  for (let i = 2; process.argv[i]; i++) {
    if (process.argv[i].match(/json$/)) {
      const profileFile = process.argv[i];
      console.log(`Reading profile ${profileFile}...`);
      profile = JSON.parse(fs.readFileSync(profileFile,{encoding:'utf8'}));
      profile.threads.forEach(thread => {
        threadName[thread.tid] = thread.name;
        processName[thread.pid] = thread.processName;
      });
    } else {
      const channelLogFile = process.argv[i];
      if (!fs.existsSync(channelLogFile)) {
        console.log("Can't find channel log file " + channelLogFile);
        process.exit(-1);
      }
      console.log(`Reading channel log ${channelLogFile}...`);
      const channelLogReadline = readline.createInterface({
        input: fs.createReadStream(channelLogFile),
        crlfDelay: Infinity
      });
      channelLogReadline.on('line', parseLogLine);

      await new Promise((accept, reject) => {
        channelLogReadline.addListener("close", accept);
      });
      console.log(`Read ${logLineCount} lines`);
    }
  }

  log.sort((a,b) => (a.timeStamp - b.timeStamp));
  log.forEach((record, i) => (record.index = i));

  // writeCsv(log, output_csv);
  // writeJson(log, output_json);

  let interestingIpc = findInteresting(log, 'ipcLatency', 0.005, 10);
  // let interestingThreadDelay = findInteresting(log, 'sinceRead', 0.01);

  console.log(`Found ${interestingIpc.length} interesting sets of IPC latency`);
  interestingIpc.forEach(set => {
    let filenameBase = `${graphDirectory}/plot-ipc-${set[0].fromPid}-` +
      `${set[0].toPid}-${Math.floor(set[0].timeStamp)}-${set.length}`;

    writeGraph(set, `${filenameBase}.svg`, profile);
    writeHtml(set, `${filenameBase}.html`);
  });

})();

function writeHtml(messages, filename) {
  const out = fs.createWriteStream(filename, {flags: 'w'});
  const start = messages[0].timeStamp - messages[0].sinceSend;
  out.write(`
    <style>
      table td + td {border-left: 1px solid black}
      table tr + tr {border-left: 1px solid black}
      :target { background-color: #ddd }
    </style>
    <table>
      <tr>
        <th>Time</th>
        <th>From</th>
        <th>To</th>
        <th>Seq</th>
        <th>#</th>
        <th>Message</th>
        <th>Size</th>
        <th>IO Recv</th>
        <th>IO Write</th>
        <th>IO Read</th>
        <th>Process</th>
      </tr>\n`);

  messages.forEach((m,i) => {
    out.write(`
      <tr style="color:${colors[i%colors.length]}" id="${i+1}">
        <td>${m.timeStamp}
             (start + ${truncate(m.timeStamp - m.sinceSend - start)} ms)</td>
        <td>${processName[m.fromPid] || m.fromPid} /
            ${threadName[m.sendTid] || m.sendTid}</td>
        <td>${processName[m.toPid] || m.toPid} /
            ${threadName[m.thread] || m.thread}</td>
        <td>${m.seqno}</td>
        <td><b>${i+1}</b></td>
        <td>${m.messageType}</td>
        <td>${m.size}</td>
        <td>${truncate(m.sinceSend - m.sinceHandoff)}</td>
        <td>${truncate(m.sinceSend - m.sinceWrite)}</td>
        <td>${truncate(m.sinceSend - m.sinceRead)}</td>
        <td>${truncate(m.sinceSend)}</td>
      </tr>\n`);
  });

  out.write("</table>\n");
  out.end();
}

// Truncates to three decimal places
function truncate(number) {
  return Math.round(number*1000)/1000;
}

function writeGraph(messages, filename, profile) {
  console.log(`Writing ${filename}`);

  const window = require('svgdom');
  const SVG = require('svg.js')(window);
  const document = window.document;

  const actorLabelHeight = 20;
  const startTime = messages[0].timeStamp - messages[0].sinceSend;
  const endTime = messages.reduce((a,c) => Math.max(a,c.timeStamp), 0);
  const duration = endTime - startTime;

  // Figure out how many threads we're showing
  let sendTids = new Set();
  let writeTids = new Set();
  let readTids = new Set();
  let workerTids = new Set();
  let ioSender;
  let ioReceiver;
  messages.forEach(msg => {
    ioSender = `${msg.fromPid}/${msg.writeTid}`;
    ioReceiver = `${msg.toPid}/${msg.readTid}`;
    sendTids.add(`${msg.fromPid}/${msg.sendTid}`);
    writeTids.add(`${msg.fromPid}/${msg.writeTid}`);
    readTids.add(`${msg.toPid}/${msg.readTid}`);
    workerTids.add(`${msg.toPid}/${msg.thread}`);
    threadName[msg.writeTid] = "IO Sender";
    threadName[msg.readTid] = "IO Receiver";
  });

  const fromPid = messages[0].fromPid;
  const toPid = messages[0].toPid;

  let actorIds = [].concat(Array.from(sendTids), Array.from(writeTids),
                           Array.from(readTids), Array.from(workerTids));

  const lifelineCount = actorIds.length;
  let pidTidToActor = {};
  actorIds.forEach((pidTid,i) => pidTidToActor[pidTid] = i);

  const labels = actorIds.map(x => {
    let [p,t] = x.split('/');
    p = processName[p] || p;
    t = threadName[t] || t;
    return `${p}/${t}`;
  });

  const canvasWidth = 256 * (lifelineCount + 1);
  let canvasHeight = Math.floor(canvasWidth * 1.618);

  const lifelineX = (() => {
    let x = [];
    for (let i = 0; i < lifelineCount; i++) {
      x[i] = Math.floor((canvasWidth / lifelineCount) * (i + 0.5));
    }
    return x;
  })();

  let interProcessX = (lifelineX[pidTidToActor[ioSender]] +
                       lifelineX[pidTidToActor[ioReceiver]]) / 2;

  const messageHeight = 10;

  const canvas = SVG(document.documentElement).
      size(canvasWidth,canvasHeight);
  canvas.clear();

  // Draw the lifelines
  lifelineX.forEach((x, i) => {
    canvas.line(x, actorLabelHeight, x, canvasHeight).stroke({ width: 2 });
    const label = canvas.text(labels[i]);
    label.center(x, actorLabelHeight/2);
  });

  // Draw a line to separate the processes
  canvas.line(interProcessX, 0, interProcessX, canvasHeight).
    stroke({width: 2, color: '#ffb080', dasharray: '2,2'});

  // Generate the rungs for the diagram
  let rungs = [];
  messages.forEach((message, i) => {
    const lineStyle = {width: 1, color: colors[i % colors.length]};
    const labelStyle = {size: messageHeight, fill: colors[i % colors.length] };
    const delayStyle = {width: 1, color: colors[i % colors.length],
        dasharray: '2,2'};
    const link = filename.replace(/.*\//,'').replace('svg','html') + `#${i+1}`;

    // Sending thread to writing I/O thread
    rungs.push({
      fromActor:  pidTidToActor[`${message.fromPid}/${message.sendTid}`],
      fromTime:   message.timeStamp - message.sinceSend - startTime,
      toActor:    pidTidToActor[`${message.fromPid}/${message.writeTid}`],
      toTime:     message.timeStamp - message.sinceHandoff - startTime,
      style:      lineStyle,
      labelStyle: labelStyle,
      label:      `${i+1}. ${message.messageType} (${message.size})`,
      link:       link,
    });

    // Writing I/O thread blocked
    if (message.sinceHandoff != message.sinceWrite) {
      rungs.push({
        fromActor:  pidTidToActor[`${message.fromPid}/${message.writeTid}`],
        fromTime:   message.timeStamp - message.sinceHandoff - startTime,
        toActor:    pidTidToActor[`${message.fromPid}/${message.writeTid}`],
        toTime:     message.timeStamp - message.sinceWrite - startTime,
        style:      delayStyle,
        labelStyle: labelStyle,
        label:      `${i+1}. ${message.messageType} (${message.size})`,
        link:       link,
      });
    }

    // Writing I/O thread to reading I/O thread
    rungs.push({
      fromActor:  pidTidToActor[`${message.fromPid}/${message.writeTid}`],
      fromTime:   message.timeStamp - message.sinceWrite - startTime,
      toActor:    pidTidToActor[`${message.toPid}/${message.readTid}`],
      toTime:     message.timeStamp - message.sinceRead - startTime,
      style:      lineStyle,
      labelStyle: labelStyle,
      label:      `${i+1}. ${message.messageType} (${message.size})`,
      link:       link,
    });

    // Reading I/O thread to receiving/processing thread
    rungs.push({
      fromActor:  pidTidToActor[`${message.toPid}/${message.readTid}`],
      fromTime:   message.timeStamp - message.sinceRead - startTime,
      toActor:    pidTidToActor[`${message.toPid}/${message.thread}`],
      toTime:     message.timeStamp - startTime,
      style:      lineStyle,
      labelStyle: labelStyle,
      label:      `${i+1}. ${message.messageType} (${message.size})`,
      link:       link,
    });

  });

  const timeToY = function(time) {
    return Math.floor((time / duration) *
      (canvasHeight - actorLabelHeight * 2) +
      actorLabelHeight * 2);
  };

  // Label the lines with times
  let offset = Math.floor((startTime - firstLogTimestamp)/1000);
  for (let i = 0; i < duration; i += duration/100) {
    canvas.text("~" + offset + " s + " + (Math.floor(i*100)/100) + " ms").
      move(lifelineX[0] - 120,timeToY(i) - messageHeight/2).
      font({size: messageHeight});

    canvas.line(lifelineX[0], timeToY(i),
                lifelineX[lifelineX.length-1], timeToY(i)).
      stroke({width: 0.5, color: '#a0a0a0', dasharray: '5,5'});
  }

  // Plot the rungs
  rungs.forEach(rung => {
    const x1 = lifelineX[rung.fromActor];
    const y1 = timeToY(rung.fromTime);
    const x2 = lifelineX[rung.toActor];
    const y2 = timeToY(rung.toTime);
    let line = canvas.line(x1, y1, x2, y2).stroke(rung.style);

    line.marker('end', 20, 10, add => add.polyline('0,0 10,5 0,10').
      fill(rung.style.color).stroke(rung.style));

    canvas.text(rung.label).
      path(`M${x1} ${y1-messageHeight*1.5} L${x2} ${y2-messageHeight*1.5}`).
      font(rung.labelStyle).linkTo(rung.link);
  });

  // Add function calls for receiving process TIDs
  if (profile) {
    actorIds.forEach((pidTid, i) => {
      if (workerTids.has(pidTid) || readTids.has(pidTid)) {
        const [pid, tid] = pidTid.split('/');
        plotCalls(canvas, profile, pid, tid, startTime, endTime,
                  lifelineX[i] + 10, timeToY);
      }
    });
  }

  const out = fs.createWriteStream(filename, {flags: 'w'});
  out.write(canvas.svg());
  out.end();
}

function plotCalls(canvas, profile, pid, tid, startTime, endTime,
                   x, timeToY) {
  const height = 5;
  profile.threads.forEach(thread => {
    if (thread.tid == tid && thread.pid == pid) {
      console.log(`Adding calls for ${thread.processName}/${thread.name}`);
      for (let i = 0; i < thread.samples.length; i++) {
        let time = profile.meta.startTime + thread.samples.time[i];
        if (time > startTime && time < endTime) {
          let stackIndex = thread.samples.stack[i];
          let frameIndex = thread.stackTable.frame[stackIndex];
          let functionIndex = thread.frameTable.func[frameIndex];
          let functionNameIndex = thread.funcTable.name[functionIndex];
          let functionName =
              (thread.funcTable.isJS[functionIndex]?"[js] ":"") +
              thread.stringArray[functionNameIndex];
          //console.log(functionName);
          let text = canvas.text(functionName).
            move(x ,timeToY(time - startTime) - height/2).
            font({size: height}).
            linkTo("https://searchfox.org/mozilla-central/search?q=" +
                   functionName);
        }
      }
    }
  });
}

// Returns an array of arrays, where each sub-array is a
// sequence of messages demonstrating unusally high latency

function findInteresting(log, field, percent, extra = 10) {
  let subset = log.slice();
  let entries = Math.ceil(subset.length * percent);
  console.log(`Considering ${entries}/${log.length} largest per ${field}`);

  subset.sort((a,b) => (b[field] - a[field]));
  subset.length = entries;
  let remaining = new Set(subset.map(x => x.index));
  let interesting = [];

  subset.forEach(entry => {
    if (!remaining.has(entry.index)) {
      return;
    }
    let sequence = [entry];
    remaining.delete(entry.index);
    let firstIndex = entry.index;
    let lastIndex = entry.index;

    // Work backwards to beginning of interesting segment
    let overshoot = 0;
    while (firstIndex > 0 && overshoot < extra) {
      firstIndex--;
      if (log[firstIndex].fromPid == entry.fromPid &&
          log[firstIndex].toPid == entry.toPid) {
        sequence.push(log[firstIndex]);
        if (remaining.has(firstIndex)) {
          remaining.delete(firstIndex);
          overshoot = 0;
        } else {
          overshoot++;
        }
      }
    }

    // Work forwards to end of interesting segment
    overshoot = 0;
    while (lastIndex < log.length - 1 && overshoot < extra) {
      lastIndex++
      if (log[lastIndex].fromPid == entry.fromPid &&
          log[lastIndex].toPid == entry.toPid) {
        sequence.push(log[lastIndex]);
        if (remaining.has(lastIndex)) {
          remaining.delete(lastIndex);
          overshoot = 0;
        } else {
          overshoot++;
        }
      }
    }
    sequence.sort((a,b) => ((a.timeStamp - a.sinceSend) -
                            (b.timeStamp - b.sinceSend)));
    interesting.push(sequence);
  });

  interesting.sort((a,b) => (a[0].index - b[0].index));
  return interesting;
}

function writeCsv(log, filename){
  const keys = Object.keys(log[0]);
  const out_csv = fs.createWriteStream(filename, {flags: 'w'});
  out_csv.write(keys.join(',') + "\n");
  log.forEach(entry => {
    let values = [];
    keys.forEach(key => {
      values.push(entry[key]);
    });
    out_csv.write(values.join(',') + "\n");
  });
  out_csv.end();
}

function writeJson(log, filename) {
  const out_json = fs.createWriteStream(filename, {flags: 'w'});
  out_json.write(JSON.stringify(log));
  out_json.end();
}


function parseLogLine(line){
  let fields = line.split('|');
  if (fields.length == 15) {
    logLineCount++;
    let messageStats = {
      timeStamp:    parseFloat(fields[0].trim().replace(' ','').replace(' ','.')),
      thread:       extractInteger(fields[1]),
      toPid:        extractInteger(fields[2]),
      messageType:  fields[3].trim(),
      seqno:        extractInteger(fields[4]),
      fromPid:      extractInteger(fields[5]),
      size:         extractInteger(fields[6]),

      sinceSend:    extractInteger(fields[7]) / 1000,  // Sending thread sends
      sendTid:      extractInteger(fields[8]),
      sinceHandoff: extractInteger(fields[9]) / 1000,  // IO thread recv
      sinceWrite:   extractInteger(fields[10]) / 1000, // IO thread write
      writeTid:     extractInteger(fields[11]),
      sinceRead:    extractInteger(fields[12]) / 1000, // IO thread read
      readTid:      extractInteger(fields[13]),

      // raw:         line,
    };

    if (!firstLogTimestamp || (messageStats.timeStamp < firstLogTimestamp)) {
      firstLogTimestamp = messageStats.timeStamp;
    }

    // Not sure why we get bogus log lines, but we're going to drop them.
    if (messageStats.sendTid == -1 || messageStats.readTid == -1 ||
        messageStats.sinceRead == 0) {
      return;
    }

    messageStats.ipcLatency = messageStats.sinceSend - messageStats.sinceRead;

    log.push(messageStats);
  }
}

function extractInteger(field) {
  return parseInt(field.replace(/[^0-9-]/g,''),10);
}
