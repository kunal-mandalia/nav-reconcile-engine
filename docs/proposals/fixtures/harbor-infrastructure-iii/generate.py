# /// script
# requires-python = ">=3.13"
# dependencies = ["reportlab==4.4.10", "pdfplumber==0.11.9", "pypdfium2==5.7.1"]
# ///
"""Generate fictional proposal fixtures; never seeds or changes the running demo."""
import csv
import hashlib
import json
from decimal import Decimal
from pathlib import Path

from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
import pdfplumber
import pypdfium2 as pdfium

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT.parents[1] / "assets" / "agent-workflow"
ASSETS.mkdir(parents=True, exist_ok=True)
FUND = "Harbor Infrastructure III"
W, H = 612, 792
INK, GREEN, MUTED = "#20372e", "#25543d", "#68766d"
CORE = [
    ("opening_nav", "Opening partners' capital", "84,000", "80,125"),
    ("capital_calls", "Capital funded during the quarter", "6,250", "5,000"),
    ("distributions", "Cash returned to partners", "(2,100)", "(900)"),
    ("net_income", "Net result for the period", "(375)", "(225)"),
    ("reported_nav", "Closing partners' capital", None, "84,000"),
]

def rows(reported):
    return [
        [FUND.upper()],
        ["Quarterly administrator export", "Fictional demonstration data"],
        ["Reporting scope", "Whole fund", "Not an investor capital account"],
        ["Period", "2026-04-01", "2026-06-30"],
        ["Currency / scale", "USD", "All monetary amounts below in thousands"],
        [],
        ["Historical comparison ONLY - quarter ended 31 March 2026"],
        ["Line item", "Q1 2026", "Notes"],
        ["Closing partners' capital", "84,000", "Prior quarter, not current reported NAV"],
        [],
        ["Current reporting period - 1 April to 30 June 2026"],
        ["Line item", "Current quarter", "Comparative Q1", "Notes"],
        *[[label, reported if field == "reported_nav" else value, prior,
           "Loss shown in accounting brackets.\nNo explanation of closing variance supplied."
           if field == "net_income" else "Whole-fund balance or quarter movement"]
          for field, label, value, prior in CORE],
        [],
        ["Investor account illustration ONLY"],
        ["Account", "Closing balance", "Scope"],
        ["Limited partner example", "8,770", "Investor only - not whole fund"],
        [],
        ["Export note", "Blank rows, repeated labels and ragged records are intentional."],
    ]

def write_csv(name, reported):
    with (ROOT / name).open("w", encoding="utf-8-sig", newline="") as out:
        csv.writer(out, lineterminator="\r\n").writerows(rows(reported))

def make_pdf(name, reported):
    c = canvas.Canvas(str(ROOT / name), pagesize=(W,H), invariant=1, pageCompression=1)
    c.setTitle(f"{FUND} - quarterly capital report Q2 2026")
    c.setAuthor("Fictional Northstar demo administrator")
    def text(x, y, value, size=11, font="Helvetica", color=INK):
        c.setFillColor(HexColor(color)); c.setFont(font,size); c.drawString(x,y,value)
    def base(number, title):
        c.setFillColor(HexColor("#fafbf8")); c.rect(0,0,W,H,fill=1,stroke=0)
        text(44,752,"HARBOR / PRIVATE MARKETS",10,color=GREEN)
        text(44,709,title,25,"Times-Roman")
        text(44,685,FUND,12)
        c.setStrokeColor(HexColor("#dfe5dc")); c.line(44,665,568,665)
        text(44,30,"FICTIONAL SAMPLE - NOT AN INVESTMENT REPORT",8,color=MUTED)
        text(535,30,f"{number} / 4",9,color=MUTED)
    base(1,"Quarterly capital report")
    c.bookmarkPage("overview"); c.addOutlineEntry("Overview and contents","overview",0)
    text(44,614,"Reporting period: 1 April - 30 June 2026",12)
    text(44,589,"Scope: whole fund  |  Base currency: USD",12)
    text(44,545,"Contents",18,"Times-Roman")
    for i,(title,page,key) in enumerate([
        ("Fund context and prior-period comparison",2,"context"),
        ("Capital account and closing NAV",3,"capital"),
        ("Portfolio context and glossary",4,"portfolio"),
    ]):
        y=503-i*43; text(44,y,title,12);text(545,y,str(page),12)
        c.linkRect("",key,(44,y-4,568,y+15),relative=0,thickness=0)
    text(44,314,"Reading note",15,"Times-Roman")
    for y,line in [(286,"Current and prior-quarter columns are presented side by side."),
                   (266,"Amounts on the capital schedule are expressed in USD thousands."),
                   (246,"Use the whole-fund column, not the investor example on page 2.")]:
        text(44,y,line,11)
    c.showPage()
    base(2,"Fund context")
    c.bookmarkPage("context");c.addOutlineEntry("Fund context and prior period","context",0)
    text(44,622,"Whole-fund reporting scope",17,"Times-Roman")
    text(44,593,"The quarter covers 1 April to 30 June 2026. Base currency is USD.")
    text(44,547,"Prior-period comparison - 31 March 2026",16,"Times-Roman")
    text(44,516,"Prior closing NAV: USD 84,000 thousand.")
    text(44,491,"This is the opening balance for Q2, not the reported closing Q2 NAV.")
    text(44,432,"Investor account illustration - excluded scope",16,"Times-Roman")
    text(44,401,"Example limited-partner closing capital: USD 8,770 thousand.")
    text(44,376,"This investor balance is not the whole-fund NAV.")
    c.showPage()
    base(3,"Capital account and NAV")
    c.bookmarkPage("capital");c.addOutlineEntry("Capital account and closing NAV","capital",0)
    text(44,635,"Whole fund  |  1 April - 30 June 2026",12)
    text(44,612,"Currency: USD  |  All table figures in thousands",11)
    c.setFillColor(HexColor("#e9f0e6"));c.rect(44,555,524,35,fill=1,stroke=0)
    text(54,568,"Capital movement",10)
    text(365,568,"Q2 2026",10);text(485,568,"Q1 2026",10)
    for i,(field,label,value,prior) in enumerate(CORE):
        y=527-43*i
        text(54,y,label,11)
        c.setFont("Helvetica",12);c.setFillColor(HexColor(INK))
        c.drawRightString(438,y,reported if field=="reported_nav" else value)
        c.drawRightString(558,y,prior)
        c.setStrokeColor(HexColor("#dfe5dc"));c.line(44,y-15,568,y-15)
    text(44,271,"Sign convention",16,"Times-Roman")
    text(44,245,"Bracketed distributions are cash outflows; subtract their positive magnitude.")
    text(44,222,"Bracketed net results are losses and enter the roll-forward with a minus sign.")
    text(44,179,"Administrator note",16,"Times-Roman")
    text(44,153,"No explanation for any roll-forward variance is supplied in this pack.")
    c.showPage()
    base(4,"Portfolio context")
    c.bookmarkPage("portfolio");c.addOutlineEntry("Portfolio context and glossary","portfolio",0)
    text(44,624,"Holdings summary - not a NAV roll-forward",17,"Times-Roman")
    for y,label,value in [(582,"Renewable generation","42%"),(545,"Transport infrastructure","33%"),(508,"Water and utilities","25%")]:
        text(44,y,label,12);text(510,y,value,12)
    text(44,429,"Glossary",17,"Times-Roman")
    for y,line in [(397,"Capital funded: contributions received during the reporting quarter."),
                   (373,"Cash returned: distributions to partners during the reporting quarter."),
                   (349,"Net result: signed net income or loss for the reporting quarter.")]:text(44,y,line)
    c.save()

write_csv("capital_account_messy.csv","87,700")
write_csv("capital_account_matched.csv","87,775")
make_pdf("quarterly_report.pdf","87,700")
make_pdf("quarterly_report_matched.pdf","87,775")
make_pdf("quarterly_report_conflict.pdf","87,800")

facts={"opening_nav":"84000000.000000","capital_calls":"6250000.000000","distributions":"2100000.000000","net_income":"-375000.000000","reported_nav":"87700000.000000"}
assert Decimal(facts['opening_nav'])+Decimal(facts['capital_calls'])-Decimal(facts['distributions'])+Decimal(facts['net_income'])==Decimal('87775000')
expected={
    "schema_version":1,"purpose":"Test oracle only. Never include this file in agent tools or model context.",
    "fund":{"id":"00000000-0000-4000-8000-000000000007","name":FUND,"currency":"USD","entity_scope":"fund"},
    "period":{"start":"2026-04-01","end":"2026-06-30"},
    "source_scale":"1000","reconciliation_tolerance":"0.010000","extraction_agreement_tolerance":"0.000000",
    "baseline":{"files":["capital_account_messy.csv","quarterly_report.pdf"],"facts":facts,"calculated_nav":"87775000.000000","difference":"75000.000000","outcome":"mismatch","unsupported_cause":True},
    "matched":{"files":["capital_account_matched.csv","quarterly_report_matched.pdf"],"facts":{**facts,"reported_nav":"87775000.000000"},"calculated_nav":"87775000.000000","difference":"0.000000","outcome":"matched"},
    "conflicting_sources":{"files":["capital_account_messy.csv","quarterly_report_conflict.pdf"],"conflict_field":"reported_nav","csv_amount":"87700000.000000","pdf_amount":"87800000.000000","selected_reported_nav":None,"calculated_nav":None,"difference":None,"outcome":"insufficient_evidence","reason_code":"CONFLICTING_SOURCES"},
    "injected_vlm_disagreement":{"kind":"scripted model response; not a separate source pack","field":"reported_nav","vlm_raw_text":"87,701","vlm_normalised_amount":"87701000.000000","source_normalised_amount":"87700000.000000","outcome":"insufficient_evidence","reason_code":"EXTRACTION_DISAGREEMENT"},
    "locations":{}
}
# Ground truth is declared above; extraction here only checks the produced documents.
for name in ['quarterly_report.pdf','quarterly_report_matched.pdf','quarterly_report_conflict.pdf']:
    with pdfplumber.open(ROOT/name) as doc:
        assert len(doc.pages)==4
        page=doc.pages[2]
        expected_raw='87,775' if 'matched' in name else '87,800' if 'conflict' in name else '87,700'
        assert expected_raw in page.extract_text()
        if name=='quarterly_report.pdf':
            words=page.extract_words()
            for index,(field,_,value,_) in enumerate(CORE):
                raw=expected_raw if field=='reported_nav' else value
                # x0 bounds disambiguate current vs prior quarter.
                word=next(w for w in words if w['text']==raw and 360<float(w['x0'])<438)
                expected['locations'][field]={
                    "csv":{"record_index":13+index,"column_index":2,"column_name":"Current quarter","indexing":"one-based logical CSV records including all preamble records; NOT legacy data-record numbering"},
                    "pdf":{"page_number":3,"bbox":[round(word[k],3) for k in ['x0','top','x1','bottom']],"coordinate_system":"top_left_points"},
                    "raw_text":raw,
                }
    rendered=pdfium.PdfDocument(str(ROOT/name))
    pages=range(4) if name=='quarterly_report.pdf' else [2]
    prefix='baseline' if name=='quarterly_report.pdf' else 'matched' if 'matched' in name else 'conflict'
    for index in pages:
        page=rendered[index];bitmap=page.render(scale=1.5)
        bitmap.to_pil().save(ASSETS/f'{prefix}-page-{index+1}.png')
        bitmap.close();page.close()
    rendered.close()
with (ROOT/'capital_account_messy.csv').open(encoding='utf-8-sig',newline='') as file:
    records=list(csv.reader(file))
for field,loc in expected['locations'].items():
    assert records[loc['csv']['record_index']-1][1]==loc['raw_text']
(ROOT/'expected.json').write_text(json.dumps(expected,indent=2)+'\n')
files=[]
for path in sorted(ROOT.glob('*')):
    if path.suffix in {'.csv','.pdf'}:
        data=path.read_bytes();files.append({'filename':path.name,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)})
(ROOT/'manifest.json').write_text(json.dumps({'schema_version':1,'fictional':True,'fund_id':expected['fund']['id'],'files':files},indent=2)+'\n')
print('Generated 2 messy CSVs, 3 searchable PDFs, 6 rendered previews, manifest and expected results.')
print('Validated all five baseline values and PDF/CSV source coordinates; exact Decimal difference = 75000.000000.')
