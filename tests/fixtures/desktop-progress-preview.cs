// Synthetic desktop backdrop for the actual production Frame/TaskProgress classes.
// Does not send input, inspect user windows, or capture outside this test surface.
using System;
using System.IO;
using System.Drawing;
using System.Drawing.Imaging;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace DshTakeover {
  internal sealed class ProgressTestSurface : Form {
    internal bool Changed;
    internal string Pattern="checker";
    internal ProgressTestSurface(Rectangle rectangle) {
      AutoScaleMode=AutoScaleMode.None; Bounds=rectangle; FormBorderStyle=FormBorderStyle.None;
      ShowInTaskbar=false; TopMost=true; StartPosition=FormStartPosition.Manual; DoubleBuffered=true;
    }
    protected override bool ShowWithoutActivation {get{return true;}}
    protected override CreateParams CreateParams {get{var p=base.CreateParams;p.ExStyle|=0x08000000|0x80;return p;}}
    protected override void OnPaint(PaintEventArgs e) {
      if(Pattern!="checker"){e.Graphics.Clear(Pattern=="light"?Color.FromArgb(240,240,240):Color.FromArgb(35,35,35));return;}
      for(int y=0;y<Height;y+=4)for(int x=0;x<Width;x+=4) {
        bool light=(x/4+y/4)%2==0; int band=(x/100+(Changed?1:0))%3;
        Color c=band==0?(light?Color.FromArgb(220,90,65):Color.FromArgb(45,23,15)):
          band==1?(light?Color.FromArgb(50,205,105):Color.FromArgb(15,35,25)):
          (light?Color.FromArgb(65,115,230):Color.FromArgb(17,25,50));
        using(var b=new SolidBrush(c))e.Graphics.FillRectangle(b,x,y,4,4);
      }
    }
  }
  internal static class ProgressPreview {
    [DllImport("dwmapi.dll")] static extern int DwmFlush();
    static string output; static Rectangle capture,lower; static float scale; static readonly List<object> rows=new List<object>();
    static bool OutsideCard(int x,int y) {
      float left=lower.Left-capture.X,top=lower.Top-capture.Y-39*scale;
      float right=left+lower.Width,bottom=lower.Bottom-capture.Y,radius=13*scale;
      float cx=Math.Max(left+radius,Math.Min(right-radius,x+.5f));
      float cy=Math.Max(top+radius,Math.Min(bottom-radius,y+.5f));
      // Exclude the card's antialiased one-pixel edge from the desktop comparison.
      return Math.Sqrt(Math.Pow(x+.5f-cx,2)+Math.Pow(y+.5f-cy,2))>radius+1.5f;
    }
    static void Capture(string name) {
      DwmFlush();
      using(var image=new Bitmap(capture.Width,capture.Height,PixelFormat.Format32bppArgb)) {
        using(var g=Graphics.FromImage(image))g.CopyFromScreen(capture.Location,Point.Empty,image.Size);
        image.Save(Path.Combine(output,name+".png"));
        double variation=0; int count=0;
        int y=lower.Bottom-capture.Y-7;
        for(int x=lower.Left-capture.X+25;x<lower.Right-capture.X-30;x++) {
          var a=image.GetPixel(x,y); var b=image.GetPixel(x+4,y);
          variation+=Math.Abs(a.R-b.R)+Math.Abs(a.G-b.G)+Math.Abs(a.B-b.B);count++;
        }
        int outsideChanged=0,brightSeams=0,outsideJump=0;
        if(name=="light"||name=="dark") {
          int expected=name=="light"?240:35;
          for(int py=0;py<image.Height;py++)for(int px=0;px<image.Width;px++) {
            var pixel=image.GetPixel(px,py);
            if(OutsideCard(px,py)&&Math.Max(Math.Abs(pixel.R-expected),Math.Max(Math.Abs(pixel.G-expected),Math.Abs(pixel.B-expected)))>3)outsideChanged++;
            // Native rounded windows have a soft system shadow. It is allowed;
            // the previous rectangular blur leaked an abrupt 34-level edge into
            // the bottom corners. Check continuity outside the foreground shape.
            if(OutsideCard(px,py))foreach(var offset in new[]{new Point(1,0),new Point(0,1)}) {
              int nx=px+offset.X,ny=py+offset.Y;
              if(nx>=image.Width||ny>=image.Height||!OutsideCard(nx,ny))continue;
              var next=image.GetPixel(nx,ny);
              outsideJump=Math.Max(outsideJump,Math.Max(Math.Abs(pixel.R-next.R),Math.Max(Math.Abs(pixel.G-next.G),Math.Abs(pixel.B-next.B))));
            }
          }
          for(int py=lower.Top-capture.Y+2;py<lower.Bottom-capture.Y-16*scale;py++)foreach(int edge in new[]{lower.Left-capture.X,lower.Right-capture.X-1}) {
            var inner=image.GetPixel(edge+(edge==lower.Left-capture.X?4:-4),py);
            int limit=Math.Max(expected,Math.Max(inner.R,Math.Max(inner.G,inner.B)))+8;
            for(int px=edge-1;px<=edge+1;px++){var p=image.GetPixel(px,py);if(Math.Max(p.R,Math.Max(p.G,p.B))>limit)brightSeams++;}
          }
        }
        rows.Add(new {name,variation=variation/count,outsideChanged,outsideJump,brightSeams,foreground=Native.GetForegroundWindow().ToInt64(),
          left=image.GetPixel(lower.Left-capture.X+35,y).ToArgb(),right=image.GetPixel(lower.Right-capture.X-35,y).ToArgb()});
      }
    }
    [STAThread] static void Main(string[] args) {
      Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); Application.EnableVisualStyles();
      output=args[0]; Directory.CreateDirectory(output);
      var monitor=Screen.PrimaryScreen.Bounds; uint dpi=96,dy=96;
      Native.GetDpiForMonitor(Native.MonitorFromPoint(new Native.Point(monitor.Left+10,monitor.Top+10),2),0,out dpi,out dy);
      scale=Math.Max(1f,Math.Min(3f,dpi/96f));
      var progress=new TaskProgress {Task="查找并下载产品说明书",Current="打开官方网站",Description="确认来源，查找对应的产品说明书",Status="working"};
      lower=progress.BackdropBounds(monitor,"top",scale);
      capture=new Rectangle(lower.Left-24,lower.Top-(int)(39*scale)-12,lower.Width+48,lower.Height+(int)(39*scale)+24);
      using(var surface=new ProgressTestSurface(capture)) {
        surface.Shown+=async delegate {
          try {
            await Task.Delay(300); Capture("baseline");
            using(var frame=new Frame(monitor,"Rufa 正在操作电脑","top",true,progress)) {
              frame.Show();frame.Present(255);await Task.Delay(400);
              rows.Add(new {applied=frame.BackdropApplied,clickThrough=frame.ClickThrough,scale});
              Capture("working");
              foreach(var pattern in new[]{"light","dark"}) {
                surface.Pattern=pattern;surface.Invalidate();await Task.Delay(300);Capture(pattern);
              }
              surface.Pattern="checker";
              surface.Changed=true;surface.Invalidate();await Task.Delay(350);Capture("live-background");
              progress.Status="stopped";progress.Current="电脑任务已停止";progress.Description="本次电脑操作已停止。";
              frame.UpdateContent("Rufa 正在操作电脑","top",progress);frame.Present(255);
              await Task.Delay(250);Capture("stopped");
            }
            await Task.Delay(250);Capture("released");
          } catch(Exception error) {rows.Add(new {error=error.ToString()});Environment.ExitCode=1;}
          finally {File.WriteAllText(Path.Combine(output,"report.json"),new JavaScriptSerializer().Serialize(rows));surface.Close();}
        };
        Application.Run(surface);
      }
    }
  }
}
