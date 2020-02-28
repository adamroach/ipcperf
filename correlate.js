#!/usr/bin/env node

const output_csv = 'output.csv';
const output_json = 'output.json';

// Modules
const fs = require('fs');
const readline = require('readline');

// Globals
let logLineCount = 0;
let log = {};
let matched = [];

(async function main() {

  const profileFile = process.argv[2];

  if (!fs.existsSync(profileFile)) {
    console.log("Can't find profile file " + profileFile);
    process.exit(-1);
  }

  console.log("Reading profile...");
  const profile = JSON.parse(fs.readFileSync(profileFile,{encoding:'utf8'}));

  for (let i = 3; process.argv[i]; i++) {
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

  profile.threads.forEach(thread => {
    console.log(`pid = ${thread.pid}, tid = ${thread.tid} - ` +
        `${thread.processName}/${thread.name}`);
    thread.markers.data.forEach(marker => {
      if (marker && marker.type && marker.type == 'IPC') {

        const pidPair = (marker.direction == 'receiving') ?
          (marker.otherPid + '-' + thread.pid) :
          (thread.pid + '-' + marker.otherPid);

        if (!log[pidPair] || !log[pidPair][marker.messageSeqno]) {
          return;
        }

        const markerTime = profile.meta.startTime + marker.startTime;

        // Find the message with the seqno that is closest in time
        let index = 0;
        let bestDelta = Math.abs(log[pidPair][marker.messageSeqno][0].
            timeStamp - markerTime);

        log[pidPair][marker.messageSeqno].forEach((entry,i) => {
          const delta = Math.abs(entry.timeStamp - markerTime);
          if (delta < bestDelta) {
            bestDelta = delta;
            index = i;
          }
        });

        // Last-ditch sanity check: do the message types match?
        if (marker.messageType !=
            log[pidPair][marker.messageSeqno][index].messageType) {
          return;
        }

        log[pidPair][marker.messageSeqno][index]
          ['profiler' + marker.direction.replace(/^./, c => c.toUpperCase())] = 
            markerTime;

        log[pidPair][marker.messageSeqno][index].sync = marker.sync;

        // If we've found both sending and receving markers, this
        // record has been completely correlated.
        if (log[pidPair][marker.messageSeqno][index].profilerSending &&
            log[pidPair][marker.messageSeqno][index].profilerReceiving) {

          log[pidPair][marker.messageSeqno][index].profilerLatency =
            log[pidPair][marker.messageSeqno][index].profilerReceiving -
            log[pidPair][marker.messageSeqno][index].profilerSending;

          log[pidPair][marker.messageSeqno][index].latencyDelta =
            log[pidPair][marker.messageSeqno][index].profilerLatency -
            log[pidPair][marker.messageSeqno][index].latency;

          //console.log(marker);
          //console.log(log[pidPair][marker.messageSeqno][index]);
          matched.push(log[pidPair][marker.messageSeqno][index]);
        }

      }
    });
  });

  matched.sort((a,b) => (a.timeStamp - b.timeStamp));
  // console.log(matched);
  const keys = Object.keys(matched[0]);

  const out_csv = fs.createWriteStream(output_csv, {flags: 'w'});
  out_csv.write(keys.join(',') + "\n");
  matched.forEach(entry => {
    let values = [];
    keys.forEach(key => {
      values.push(entry[key]);
    });
    out_csv.write(values.join(',') + "\n");
  });
  out_csv.end();

  const out_json = fs.createWriteStream(output_json, {flags: 'w'});
  out_json.write(JSON.stringify(matched));
  out_json.end();

})();

function parseLogLine(line){
  let fields = line.split('|');
  if (fields.length == 10) {
    logLineCount++;
    let messageStats = {
      timeStamp:   parseFloat(fields[0].trim().replace(' ','').replace(' ','.')),
      thread:      fields[1].replace('thread ','').trim(),
      pid:         extractInteger(fields[2]),
      messageType: fields[3].trim(),
      seqno:       extractInteger(fields[4]),
      fromPid:     extractInteger(fields[5]),
      size:        extractInteger(fields[6]),
      latency:     extractInteger(fields[7]) / 1000,
      blocked:     extractInteger(fields[8]) / 1000,
      ipc:         extractInteger(fields[9]) / 1000,
      // raw:         line,
    };

    const pidPair = messageStats.fromPid + '-' + messageStats.pid;

    if (!log[pidPair]) {
     log[pidPair] = {}
    }

    if (!log[pidPair][messageStats.seqno]) {
     log[pidPair][messageStats.seqno] = []
    }
    log[pidPair][messageStats.seqno].push(messageStats);
  }
}

function extractInteger(field) {
  return parseInt(field.replace(/[^0-9-]/g,''),10);
}
