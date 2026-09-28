"""Build OpenFon identity assets. Requires fontTools, brotli and CairoSVG.

Run from any directory. The approved source wordmark is never modified.
Only assets/ is written; application integration is an explicit separate copy.
"""
from pathlib import Path
from xml.etree import ElementTree as ET
from copy import deepcopy
import json
import hashlib
import cairosvg
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen

BASE = Path(__file__).resolve().parent
OUT = BASE / 'assets'
SOURCE = BASE.parent / 'lilita-f-variants/4-straighter-stem-tight-spacing.svg'
NS = 'http://www.w3.org/2000/svg'
ET.register_namespace('', NS)
root = ET.parse(SOURCE).getroot()

def save_svg(name, svg, width=None):
    data = ET.tostring(svg, encoding='unicode') if not isinstance(svg, str) else svg
    (OUT / (name + '.svg')).write_text(data)
    cairosvg.svg2png(bytestring=data.encode(), write_to=str(OUT / (name + '.png')), output_width=width)

def recolor(svg, text, mark):
    for el in svg.iter():
        if el.get('fill') == '#152a49': el.set('fill', text)
        elif el.get('fill') == '#2457c5': el.set('fill', mark)
    return svg

for name, ink, blue in [('primary','#152a49','#2457c5'), ('inverse','#ffffff','#f6e99b'), ('mono','#152a49','#152a49'), ('white','#ffffff','#ffffff')]:
    save_svg('openfon-logo-' + name, recolor(deepcopy(root), ink, blue), 1482)

f = next(el for el in root if el.get('fill') == '#2457c5')
mark = deepcopy(f)
mark.attrib.pop('transform')
for name, color in [('blue','#2457c5'), ('inverse','#f6e99b'), ('mono','#152a49')]:
    svg = ET.Element('{' + NS + '}svg', {'width':'64','height':'64','viewBox':'-20 -2 64 64','role':'img','aria-label':'OpenFon'})
    shape = deepcopy(mark); shape.set('fill',color); svg.append(shape)
    save_svg('openfon-mark-' + name,svg,512)

mark_content = ET.tostring(mark,encoding='unicode')
favicon = f'<svg xmlns="{NS}" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#2457c5"/><g transform="translate(22 5) scale(.88)">{mark_content.replace("#2457c5", "#f6e99b")}</g></svg>'
save_svg('favicon',favicon,512)

fonts={}
for name in ['LilitaOne','NunitoSans']:
    font = TTFont(OUT/'fonts'/f'{name}.ttf')
    if 'fvar' in font:
        font=instantiateVariableFont(font,{'opsz':12,'wdth':100,'YTLC':500},inplace=False)
    font.flavor='woff2'; font.save(OUT/'fonts'/f'{name}.woff2')
    font.flavor=None
    if 'fvar' in font: font=instantiateVariableFont(font,{'wght':600},inplace=False)
    fonts[name]=font

def text_paths(text,x,y,size,color='#152a49',face='NunitoSans'):
    font=fonts[face]; glyphs=font.getGlyphSet(); cmap=font.getBestCmap(); scale=size/font['head'].unitsPerEm
    result=f'<g fill="{color}" transform="translate({x} {y}) scale({scale} {-scale})">'
    advance=0
    for char in text:
        name=cmap.get(ord(char),'space'); pen=SVGPathPen(glyphs); glyphs[name].draw(pen)
        result+=f'<path transform="translate({advance} 0)" d="{pen.getCommands()}"/>'
        advance+=glyphs[name].width
    return result+'</g>'

def logo(x,y,w,inverse=False):
    svg=recolor(deepcopy(root),'#fff','#f6e99b') if inverse else root
    content=''.join(ET.tostring(el,encoding='unicode') for el in svg if not el.tag.endswith('title'))
    return f'<g transform="translate({x} {y}) scale({w/246.88})">{content}</g>'

social=f'<svg xmlns="{NS}" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#2457c5"/>'
social+=logo(68,48,290,True)
social+=text_paths('A warm welcome.',65,300,76,'#fff','LilitaOne')
social+=text_paths('A clear next step.',65,389,76,'#f6e99b','LilitaOne')
social+=text_paths('An AI receptionist for small businesses.',68,538,28,'#fff')
social+='</svg>'
save_svg('openfon-social',social,1200)

poster=f'<svg xmlns="{NS}" width="1080" height="1350" viewBox="0 0 1080 1350"><rect width="1080" height="1350" fill="#f6e99b"/>'
poster+=logo(64,60,320)
for line,y in [('Keep your',415),('hands on',540),('your business.',665)]: poster+=text_paths(line,64,y,112,face='LilitaOne')
poster+=f'<path d="M90 735 C90 900 830 710 830 890" stroke="#2457c5" stroke-width="6" fill="none"/>'
poster+='<rect x="64" y="860" width="952" height="325" rx="16" fill="white"/>'
poster+=text_paths('A clear message for when you’re ready.',102,932,33)
poster+=text_paths('“Can you help with a bicycle repair?',102,1002,32)
poster+=text_paths('Please call me back this afternoon.”',102,1045,32)
poster+=text_paths('Illustrative example · Callback requested',102,1131,22,'#5f708a')
poster+=text_paths('An AI receptionist for small businesses.',64,1270,28)
poster+='</svg>'
save_svg('openfon-poster',poster,1080)

board=f'<svg xmlns="{NS}" width="1600" height="1100" viewBox="0 0 1600 1100"><rect width="1600" height="1100" fill="#f3f5f8"/><rect width="1600" height="500" fill="#2457c5"/>'
board+=logo(64,45,350,True)
board+=text_paths('A warm welcome.',62,300,96,'#fff','LilitaOne')
board+=text_paths('A clear next step.',62,410,96,'#f6e99b','LilitaOne')
board+=text_paths('OpenFon / Brand identity v1',1100,82,24,'#fff')
board+='<rect x="64" y="554" width="865" height="222" fill="white"/>'
board+=logo(92,567,520)
board+=text_paths('The approved mark · Lilita One + the handset f',90,747,23)
board+=text_paths('Welcoming. Capable. Plainspoken.',64,863,36)
board+=text_paths('Teach it your business. Try a conversation.',64,920,28)
board+=text_paths('Review what callers needed.',64,963,28)
board+='<rect x="995" y="554" width="541" height="342" rx="16" fill="#f6e99b"/>'
board+=text_paths('A message, clearly left.',1032,612,35,face='LilitaOne')
board+=text_paths('Can you help with a repair?',1032,683,26)
board+=text_paths('Please call me back this afternoon.',1032,721,26)
board+=text_paths('Callback requested',1032,798,25)
board+=text_paths('Illustrative example',1032,857,19)
for i,(name,color,fg) in enumerate([('Blue','#2457c5','#fff'),('Ink','#152a49','#fff'),('Butter','#f6e99b','#152a49'),('Paper','#f3f5f8','#152a49')]):
    x=995+i*135.25
    board+=f'<rect x="{x}" y="930" width="135.25" height="112" fill="{color}"/>'
    board+=text_paths(name,x+14,971,19,fg)+text_paths(color,x+14,1006,16,fg)
board+='</svg>'
save_svg('openfon-brand-board',board,1600)

colors={'blue':'#2457c5','blue-deep':'#18449f','ink':'#152a49','butter':'#f6e99b','paper':'#f3f5f8','white':'#ffffff','muted':'#5f708a','line':'#dce3ed','success':'#216246','error':'#a52f3f'}
tokens={'name':'OpenFon','version':'1.0.0','colors':colors,'fonts':{'display':'Lilita One','body':'Nunito Sans','appCurrent':'Avenir Next, Avenir, Segoe UI, system-ui, sans-serif'},'radius':{'control':'8px','sheet':'16px'},'spacing':[4,8,12,16,24,32,48,64,80],'logo':{'master':'../../lilita-f-variants/4-straighter-stem-tight-spacing.svg','minimumWidthPx':120,'clearSpace':'At least half the lowercase o height on every side'},'motion':{'duration':'180ms','easing':'cubic-bezier(.16,1,.3,1)','reduceMotion':True}}
(OUT/'tokens.json').write_text(json.dumps(tokens,indent=2)+'\n')
css='/* OpenFon identity tokens v1. No global styling or network font dependency. */\n:root {\n'
for key,value in colors.items(): css+=f'  --of-brand-{key}: {value};\n'
css+='  --of-brand-display: "Lilita One", sans-serif;\n  --of-brand-body: "Nunito Sans", "Avenir Next", "Segoe UI", sans-serif;\n  --of-brand-radius-control: 8px;\n  --of-brand-radius-sheet: 16px;\n  --of-brand-duration: 180ms;\n  --of-brand-ease: cubic-bezier(.16, 1, .3, 1);\n}\n'
(OUT/'tokens.css').write_text(css)

def luminance(color):
    rgb=[int(color[i:i+2],16)/255 for i in (1,3,5)]
    rgb=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in rgb]
    return sum(a*b for a,b in zip(rgb,[.2126,.7152,.0722]))
ratios=[]
for fg,bg in [('ink','white'),('ink','paper'),('ink','butter'),('white','blue'),('butter','blue'),('muted','white'),('muted','paper'),('blue','white')]:
    a,b=sorted([luminance(colors[fg]),luminance(colors[bg])]); ratio=(b+.05)/(a+.05)
    ratios.append({'foreground':fg,'background':bg,'ratio':round(ratio,2),'normalTextAA':ratio>=4.5})
(OUT/'contrast.json').write_text(json.dumps(ratios,indent=2)+'\n')
assert all(i['normalTextAA'] for i in ratios)
manifest={'approvedSource':str(SOURCE.relative_to(BASE.parent)),'approvedSourceSHA256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),'assets':{str(p.relative_to(OUT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(OUT.rglob('*')) if p.is_file() and p.name!='manifest.json'}}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Built logos, marks, favicon, social card, poster, board, fonts, tokens and contrast report.')
print(json.dumps(ratios,indent=2))
