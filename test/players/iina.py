"""Drive the dedicated IINA test window's mpv IPC, never another player instance."""
import json, socket, time, pathlib
root=pathlib.Path(__file__).resolve().parents[2]/'test-results/players'
s=socket.socket(socket.AF_UNIX);s.connect('/tmp/hls-player-iina.sock');s.settimeout(5);reader=s.makefile('rb');seq=0

def command(*args):
 global seq
 seq+=1;s.sendall((json.dumps({'command':args,'request_id':seq})+'\n').encode())
 while True:
  result=json.loads(reader.readline())
  if result.get('request_id')==seq:return result

def get(name):return command('get_property',name).get('data')
results=[]
for case in json.loads((root/'manifest.json').read_text())['entries']+[{'name':'external-sidecar','file':'avc-mp4.mp4'}]:
 name=case['name'];r={'name':name,'runtime':get('mpv-version')}
 command('loadfile',str(root/case['file']))
 time.sleep(.3);command('set_property','pause',True)
 if name=='external-sidecar':command('sub-add',str(root/'external.vtt'),'select')
 r['tracks']=get('track-list');r['duration']=get('duration');r['audioSelections']=[]
 for t in r['tracks'] or []:
  if t['type']=='audio':
   command('set_property','aid',t['id']);time.sleep(.15)
   r['audioSelections'].append({'id':t['id'],'selected':get('aid'),'codec':get('audio-codec')})
 subs=[t for t in r['tracks'] or [] if t['type']=='sub']
 if subs:command('set_property','sid',subs[0]['id'])
 command('seek',.75,'absolute+exact');time.sleep(.5)
 r['subtitleText']=get('sub-text');r['subtitleCodec']=get('sub-codec')
 r['screenshot']=command('screenshot-to-file',str(root/'screenshots'/('iina-'+name+'.png')),'subtitles')
 command('set_property','pause',False)
 end=time.monotonic()+12
 while not get('eof-reached') and time.monotonic()<end:time.sleep(.1)
 r['eof']=get('eof-reached');r['position']=get('time-pos');results.append(r)
 (root/'iina.json').write_text(json.dumps(results,indent=2,ensure_ascii=False))
 print(name,r['eof'],len(r['tracks'] or []),r['subtitleText'],flush=True)
command('stop')
