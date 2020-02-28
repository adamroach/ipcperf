#!/usr/bin/env node

// Creates a ladder diagram with three actors:
// - IO thread in sending process
// - IO thread in receiving process
// - Worker thread in receiving process

const proportional = true;

// Modules
const fs = require('fs');
const window = require('svgdom');
const SVG = require('svg.js')(window);
const document = window.document;

const startTime = parseFloat(process.argv[2]);
const endTime = parseFloat(process.argv[3]);
const output = `plot-${startTime}-${endTime}.svg`;
const messageFile = "output.json"; // Output from correlate.js

const matchPid = 18932;
const matchTid = 16876;
const profile = "2020-02-13-14-10/Firefox 2020-02-13 14.06 profile.json";

if (!startTime || !endTime || startTime == NaN || endTime == NaN) {
  console.log("Double-check your start and end times.");
  process.exit(-1);
}
if (startTime >= endTime) {
  console.log("End time must be greater than start time.");
  process.exit(-1);
}
const duration = endTime - startTime;


// Parameters for the diagram
const canvasWidth = 1024;
let canvasHeight = Math.floor(canvasWidth * 1.618);
const actorLabelHeight = 20;
const lifelineCount = 3;
const lifelineX = (() => {
  let x = [];
  for (let i = 0; i < lifelineCount; i++) {
    x[i] = Math.floor((canvasWidth / lifelineCount) * (i + 0.5));
  }
  return x;
})();

const colors = ['red','orange','brown','green','blue','purple'];
const labels = ['Sending Worker Thread', 'Receiving IO Thread',
                'Receiving Worker Thread'];
const messageHeight = 10;

let timeToOrdinalY = {};

(async function main() {
  console.log("Reading messages...");
  let messages = JSON.parse(fs.readFileSync(messageFile,{encoding:'utf8'}));

  let rungs = [];
  let matched = [];

  // Figure out which messages match our time range
  messages.forEach((message) => {
    if (message.timeStamp < startTime || message.timeStamp > endTime) {
      return;
    }
    matched.push(message);
  });
  messages = undefined;

  // Set up the canvas
  if (!proportional) {
    canvasHeight = matched.length * messageHeight * 4;
  }

  const canvas = SVG(document.documentElement).size(canvasWidth,canvasHeight);

  lifelineX.forEach((x, i) => {
    canvas.line(x, actorLabelHeight, x, canvasHeight).stroke({ width: 2 });
    const label = canvas.text(labels[i]);
    label.center(x, actorLabelHeight/2);
  });


  // Calculate the times for each rung
  matched.forEach((message, i) => {
    const ioSendTime = message.timeStamp - startTime;
    const ioRecvTime = message.timeStamp + message.ipc - startTime;
    const ioRecvDispatchTime = message.timeStamp + message.latency - startTime;
    const profilerSendingTime = message.profilerSending - startTime; // unused
    const workerRecvTime = message.profilerReceiving - startTime;

    const lineStyle = {width: 1, color: colors[i % colors.length] };
    const labelStyle = {size: messageHeight, fill: colors[i % colors.length] };

    rungs.push({
      fromActor:  0,
      fromTime:   ioSendTime,
      toActor:    1,
      toTime:     ioRecvTime,
      style:      lineStyle,
      label:      `${i+1}. ${message.messageType} (${message.size})`,
      labelStyle: labelStyle,
    });

    rungs.push({
      fromActor:  1,
      fromTime:   ioRecvDispatchTime,
//      fromTime:   ioRecvTime,
//      fromTime:   profilerSendingTime,
      toActor:    2,
      toTime:     workerRecvTime,
      style:      lineStyle,
      label:      `${i+1}. ${message.messageType} (${message.size})`,
      labelStyle: labelStyle,
    });
  });

  // Calculate an ordinal for each timestamp (only for non-proportional)
  let times = new Set();
  rungs.forEach(rung => {
    times.add(rung.fromTime);
    times.add(rung.toTime);
  });
  times = Array.from(times);
  times.sort((a,b) => (a-b));
  times.forEach((time, i) => {
    timeToOrdinalY[time] = Math.floor((i) *
                                      (canvasHeight - actorLabelHeight * 2)
                                      / times.length +
                                      actorLabelHeight * 2);
  });


  // Label the lines with times
  if (proportional) {
    for (let i = 0; i < duration; i += duration/100) {
      canvas.text((Math.floor(i*100)/100) + " ms").
        move(lifelineX[0] - 70,timeToY(i) - messageHeight/2).
        font({size: messageHeight});

      canvas.line(lifelineX[0], timeToY(i),
                  lifelineX[lifelineX.length-1], timeToY(i)).
        stroke({width: 1, color: '#a0a0a0', dasharray: '5,5'});
    }
  } else {
    times.forEach((time) => {
      canvas.text((Math.floor(time*100)/100) + " ms").
        move(lifelineX[2] + 10,timeToY(time) - messageHeight/2).
        font({size: messageHeight});
    });
  }

  // Plot the rungs
  rungs.forEach(rung => {
    const x1 = lifelineX[rung.fromActor];
    const y1 = timeToY(rung.fromTime);
    const x2 = lifelineX[rung.toActor];
    const y2 = timeToY(rung.toTime);
    canvas.line(x1, y1, x2, y2).stroke(rung.style);

    canvas.text(rung.label).
      path(`M${x1} ${y1-messageHeight*1.5} L${x2} ${y2-messageHeight*1.5}`).
      font(rung.labelStyle);
  });

  //plotCalls(canvas, profile, matchPid, matchTid);

  const out = fs.createWriteStream(output, {flags: 'w'});
  out.write(canvas.svg());
  out.end();
})();


function plotCalls(canvas, profileFile, pid, tid) {
  const height = 5;
  if (!fs.existsSync(profileFile)) {
    console.log("Can't find profile file " + profileFile);
    return;
  }
  console.log(`Reading profile ${profileFile}...`);
  const profile = JSON.parse(fs.readFileSync(profileFile,{encoding:'utf8'}));
  profile.threads.forEach(thread => {
    if (thread.tid == tid && thread.pid == pid) {
      console.log(`Adding calls for ${thread.processName}/${thread.name}`);
      for (let i = 0; i < thread.samples.length; i++) {
        let time = profile.meta.startTime + thread.samples.time[i];
        if (time > startTime && time < endTime) {
          let stackIndex = thread.samples.stack[i];
          let functionIndex = thread.stackTable.frame[stackIndex];
          let functionNameIndex = thread.funcTable.name[functionIndex];
          let functionName = (thread.funcTable.isJS[functionIndex]?"[js] ":"") +
              thread.stringArray[functionNameIndex];
          console.log(`${functionName}`);
          let text = canvas.text(functionName).
            move(lifelineX[2] + 10,timeToY(time - startTime) - height/2).
            font({size: height});
        }
      }
    }
  });
}

function timeToY(time) {
  if (!proportional) {
    return timeToOrdinalY[time];
  }

  return Math.floor((time / duration) *
                    (canvasHeight - actorLabelHeight * 2) +
                    actorLabelHeight * 2);
}
