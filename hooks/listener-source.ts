// The microphone listener, a small macOS program. The mod writes this text to /var/tmp/sidekick/listen.swift
// and compiles it there once with swiftc; see "What it runs, stores, and sends" in the README.
// String.raw keeps the backslashes Swift needs. Edit this like any Swift file.
export const LISTENER_SWIFT = String.raw`
// sidekick-listen: records from a microphone and prints what was said, using macOS's own speech
// recognition (on-device where the language model is installed). Exits when the speaker pauses for
// --silence seconds after speech began, or after --max seconds.
//   stderr: "listening", "partial:<text>", "device:<name>", "note:<info>", "error:<why>"
//   stdout: the final text
//   exit:   0 text · 2 nothing heard · 3 permission denied · 4 recognizer unavailable · 5 no microphone
// Flags: --silence <s> --max <s> --lang <id> --device <name part> --server --file <audio> --list-devices
import AVFoundation
import Foundation
import Speech

var silence = 1.4
var maxSecs = 30.0
var lang = Locale.current.identifier
var file: String? = nil
var forceServer = false
var deviceWanted: String? = nil
var listDevices = false
var it = CommandLine.arguments.dropFirst().makeIterator()
while let a = it.next() {
  switch a {
  case "--silence": silence = Double(it.next() ?? "") ?? silence
  case "--max": maxSecs = Double(it.next() ?? "") ?? maxSecs
  case "--lang": lang = it.next() ?? lang
  case "--file": file = it.next()
  case "--server": forceServer = true
  case "--device": deviceWanted = it.next()
  case "--list-devices": listDevices = true
  default: break
  }
}

func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }
func fail(_ code: Int32, _ s: String) -> Never { log("error:" + s); exit(code) }
func spin(until ready: () -> Bool) { while !ready() { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) } }

func microphones() -> [AVCaptureDevice] {
  if #available(macOS 14, *) {
    return AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified).devices
  }
  return AVCaptureDevice.devices(for: .audio)
}

if listDevices {
  let fallback = AVCaptureDevice.default(for: .audio)
  for d in microphones() { print("\(d.localizedName)\(d.uniqueID == fallback?.uniqueID ? "  (default)" : "")") }
  exit(0)
}

// permissions: speech recognition, then the microphone (each prompts once for your terminal)
var speech = SFSpeechRecognizer.authorizationStatus()
if speech == .notDetermined {
  SFSpeechRecognizer.requestAuthorization { speech = $0 }
  spin { speech != .notDetermined }
}
guard speech == .authorized else { fail(3, "speech recognition is not allowed for your terminal (System Settings > Privacy & Security > Speech Recognition)") }

if file == nil {
  var mic = AVCaptureDevice.authorizationStatus(for: .audio)
  if mic == .notDetermined {
    AVCaptureDevice.requestAccess(for: .audio) { mic = $0 ? .authorized : .denied }
    spin { mic != .notDetermined }
  }
  guard mic == .authorized else { fail(3, "microphone is not allowed for your terminal (System Settings > Privacy & Security > Microphone)") }
}

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: lang)), recognizer.isAvailable else {
  fail(4, "speech recognizer unavailable for \(lang)")
}
let onDevice = recognizer.supportsOnDeviceRecognition && !forceServer
let request: SFSpeechRecognitionRequest = file.map { SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: $0)) } ?? SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
request.requiresOnDeviceRecognition = onDevice
if #available(macOS 13, *) { request.addsPunctuation = true }

// the microphone, through AVFoundation capture (the path ffmpeg and the camera apps use)
final class Sink: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
  let request: SFSpeechAudioBufferRecognitionRequest
  init(_ request: SFSpeechAudioBufferRecognitionRequest) { self.request = request }
  func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
    request.appendAudioSampleBuffer(sampleBuffer)
  }
}
var session: AVCaptureSession? = nil
var sink: Sink? = nil
if file == nil {
  let all = microphones()
  let device = deviceWanted.flatMap { want in all.first { $0.localizedName.lowercased().contains(want.lowercased()) } }
    ?? AVCaptureDevice.default(for: .audio)
    ?? all.first
  guard let device, let input = try? AVCaptureDeviceInput(device: device) else { fail(5, "no microphone found") }
  log("device:\(device.localizedName)")
  let s = AVCaptureSession()
  let out = AVCaptureAudioDataOutput()
  let k = Sink(request as! SFSpeechAudioBufferRecognitionRequest)
  out.setSampleBufferDelegate(k, queue: DispatchQueue(label: "sidekick.listen"))
  guard s.canAddInput(input), s.canAddOutput(out) else { fail(5, "microphone cannot be captured") }
  s.addInput(input)
  s.addOutput(out)
  s.startRunning()
  session = s
  sink = k
}

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
session?.stopRunning()
(request as? SFSpeechAudioBufferRecognitionRequest)?.endAudio()
task.cancel()
if transcript.isEmpty { exit(2) }
print(transcript)
exit(0)
`

/** Usage descriptions linked into the binary, so macOS can ask for the microphone and speech recognition. */
export const LISTENER_PLIST = String.raw`
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>dev.meertarbani.sidekick.listen</string>
  <key>CFBundleName</key><string>sidekick-listen</string>
  <key>NSMicrophoneUsageDescription</key><string>Your sidekick listens for what you say.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Your sidekick turns what you say into text, on this Mac.</string>
</dict></plist>
`
