"""VLC macOS app acceptance through its official loopback RC interface."""
import socket,time,json,pathlib,re
root=pathlib.Path(__file__).resolve().parents[2]/'test-results/players'
s=socket.create_connection(('127.0.0.1',47282));s.settimeout(.2)
def read():
 result=''
 while True:
  try:
   data=s.recv(65536).decode();result+=data
   if not data or result.endswith('> '):return result
  except socket.timeout:return result
read()
def cmd(text):
 s.sendall((text+'\n').encode());time.sleep(.05);return read()
results=[]
for case in json.loads((root/'manifest.json').read_text())['entries']:
 name=case['name'];r={'name':name,'runtime':'VLC 3.0.23 arm64'}
 cmd('clear');cmd('add '+str(root/case['file']))
 deadline=time.monotonic()+10
 while not re.search(r'frames displayed\s*:\s*[1-9]',cmd('stats')):
  if time.monotonic()>deadline:raise RuntimeError('VLC did not render '+name)
  time.sleep(.05)
 cmd('pause');r['info']=cmd('info');r['audio']=cmd('atrack');r['subtitles']=cmd('strack');r['selections']=[]
 for kind,listing in [('atrack',r['audio']),('strack',r['subtitles'])]:
  ids=re.findall(r'\|\s+(\d+)\s+-',listing)
  for tid in ids:
   cmd(kind+' '+tid);time.sleep(.1);r['selections'].append({'kind':kind,'id':tid,'state':cmd(kind)})
  if ids:cmd(kind+' '+ids[0])
 before=set((root/'screenshots').glob('vlc-*.png'));cmd('seek 0');cmd('play');time.sleep(.7);cmd('pause');cmd('snapshot');time.sleep(.4);r['screenshots']=[p.name for p in set((root/'screenshots').glob('vlc-*.png'))-before];r['stats']=cmd('stats');r['status']=cmd('status');cmd('play');time.sleep(7 if 'hevc' in name else 5);r['endStatus']=cmd('status');results.append(r);(root/'vlc.json').write_text(json.dumps(results,indent=2));print(name,r['screenshots'],flush=True)
cmd('stop')
