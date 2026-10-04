// sidekick-listen: records from the default microphone and prints what was said, using macOS's own
// speech recognition. Exits when the speaker pauses for --silence seconds (after speech began),
// or after --max seconds. stderr: "listening", "partial:<text>", "error:<why>". stdout: the final text.
// Exit codes: 0 text, 2 nothing heard, 3 permission denied, 4 recognizer unavailable, 5 audio engine failed.
import AVFoundation
import Foundation
import Speech

var silence = 1.4
var maxSecs = 30.0
var lang = Locale.current.identifier
var it = CommandLine.arguments.dropFirst().makeIterator()
while let a = it.next() {
  switch a {
  case "--silence": silence = Double(it.next() ?? "") ?? silence
  case "--max": maxSecs = Double(it.next() ?? "") ?? maxSecs
  case "--lang": lang = it.next() ?? lang
  default: break
  }
}

func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }
func fail(_ code: Int32, _ s: String) -> Never { log("error:" + s); exit(code) }
func spin(until ready: () -> Bool) { while !ready() { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) } }

var speech = SFSpeechRecognizer.authorizationStatus()
if speech == .notDetermined {
  SFSpeechRecognizer.requestAuthorization { speech = $0 }
  spin { speech != .notDetermined }
}
guard speech == .authorized else { fail(3, "speech recognition is not allowed for your terminal (System Settings > Privacy & Security > Speech Recognition)") }

var mic = AVCaptureDevice.authorizationStatus(for: .audio)
if mic == .notDetermined {
  AVCaptureDevice.requestAccess(for: .audio) { mic = $0 ? .authorized : .denied }
  spin { mic != .notDetermined }
}
guard mic == .authorized else { fail(3, "microphone is not allowed for your terminal (System Settings > Privacy & Security > Microphone)") }

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: lang)), recognizer.isAvailable else {
  fail(4, "speech recognizer unavailable for \(lang)")
}
let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
if #available(macOS 13, *) { request.addsPunctuation = true }

let engine = AVAudioEngine()
let input = engine.inputNode
let format = input.outputFormat(forBus: 0)
guard format.sampleRate > 0 else { fail(5, "no audio input device") }
input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in request.append(buffer) }
engine.prepare()
do { try engine.start() } catch { fail(5, "audio engine: \(error.localizedDescription)") }

var transcript = ""
var lastChange = Date()
let started = Date()
var done = false
let task = recognizer.recognitionTask(with: request) { result, error in
  if let r = result {
    let t = r.bestTranscription.formattedString
    if t != transcript { transcript = t; lastChange = Date(); log("partial:" + t) }
    if r.isFinal { done = true }
  }
  if let e = error {
    if transcript.isEmpty { log("error:" + e.localizedDescription) }
    done = true
  }
}
log("listening")
spin {
  let now = Date()
  return done
    || (!transcript.isEmpty && now.timeIntervalSince(lastChange) > silence)
    || now.timeIntervalSince(started) > maxSecs
}
engine.stop()
input.removeTap(onBus: 0)
request.endAudio()
task.cancel()
if transcript.isEmpty { exit(2) }
print(transcript)
exit(0)
