import Foundation
import AVFoundation
import CoreImage
import AppKit

final class Captions: NSObject, AVPlayerItemLegibleOutputPushDelegate {
    var cues: [[String: Any]] = []
    func legibleOutput(_ output: AVPlayerItemLegibleOutput, didOutputAttributedStrings strings: [NSAttributedString], nativeSampleBuffers: [Any], forItemTime time: CMTime) {
        for text in strings where !text.string.isEmpty {
            var attrs: [[String: String]] = []
            text.enumerateAttributes(in: NSRange(location: 0, length: text.length)) { values, _, _ in
                attrs.append(Dictionary(uniqueKeysWithValues: values.map { ($0.key.rawValue, String(describing: $0.value)) }))
            }
            cues.append(["text":text.string,"time":time.seconds,"attributes":attrs])
        }
    }
}
let root = URL(fileURLWithPath: CommandLine.arguments[1])
let data = try Data(contentsOf: root.appendingPathComponent("manifest.json"))
let manifest = try JSONSerialization.jsonObject(with:data) as! [String:Any]
var results: [[String:Any]] = []
for entry in manifest["entries"] as! [[String:Any]] {
    let name = entry["name"] as! String
    let asset = AVURLAsset(url: root.appendingPathComponent(entry["file"] as! String))
    let group = asset.mediaSelectionGroup(forMediaCharacteristic:.legible)
    let audioGroup = asset.mediaSelectionGroup(forMediaCharacteristic:.audible)
    for selection in 0..<max(1,group?.options.count ?? 0) {
        let item = AVPlayerItem(asset:asset)
        let pixels = AVPlayerItemVideoOutput(pixelBufferAttributes:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA])
        item.add(pixels)
        let captions = Captions(), legible = AVPlayerItemLegibleOutput()
        legible.setDelegate(captions,queue:.main);item.add(legible)
        if let group=group {item.select(group.options[selection],in:group)}
        if let audioGroup=audioGroup, !audioGroup.options.isEmpty {item.select(audioGroup.options[min(selection,audioGroup.options.count-1)],in:audioGroup)}
        let player = AVPlayer(playerItem:item);player.isMuted=true;player.play()
        var frames=0, saved=false, ended=false
        let observer=NotificationCenter.default.addObserver(forName:.AVPlayerItemDidPlayToEndTime,object:item,queue:.main){_ in ended=true}
        let deadline=Date().addingTimeInterval(12)
        while Date()<deadline && !ended && item.status != .failed {
            RunLoop.main.run(until:Date().addingTimeInterval(0.01))
            let time=player.currentTime()
            if pixels.hasNewPixelBuffer(forItemTime:time),let buffer=pixels.copyPixelBuffer(forItemTime:time,itemTimeForDisplay:nil) {
                frames+=1
                if !saved && time.seconds>0.6 {
                    let image=CIImage(cvPixelBuffer:buffer),ctx=CIContext()
                    try? ctx.writePNGRepresentation(of:image,to:root.appendingPathComponent("screenshots/avfoundation-\(name)-\(selection).png"),format:.RGBA8,colorSpace:CGColorSpaceCreateDeviceRGB())
                    saved=true
                }
            }
        }
        var r: [String:Any] = ["name":name,"subtitleSelection":selection,"ended":ended,"frames":frames,"duration":asset.duration.seconds,"cues":captions.cues,"audioOptions":audioGroup?.options.map{["name":$0.displayName,"language":$0.extendedLanguageTag ?? ""]} ?? [],"subtitleOptions":group?.options.map{["name":$0.displayName,"language":$0.extendedLanguageTag ?? ""]} ?? []]
        if let error=item.error {r["error"]=String(describing:error)}
        results.append(r);player.pause();player.replaceCurrentItem(with:nil);NotificationCenter.default.removeObserver(observer)
        try JSONSerialization.data(withJSONObject:results,options:[.prettyPrinted,.sortedKeys]).write(to:root.appendingPathComponent("avfoundation.json"))
        print(name,selection,ended,frames,captions.cues.map{$0["text"]!})
    }
}
