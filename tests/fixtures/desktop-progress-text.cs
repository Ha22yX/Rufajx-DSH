// Render the real production card offscreen. No input, accounts or desktop capture.
using System;
using System.IO;
using System.Drawing;
using System.Drawing.Imaging;
using System.Collections.Generic;
using System.Web.Script.Serialization;

namespace DshTakeover {
  internal static class ProgressTextPreview {
    static int Pixel(float value) {return (int)Math.Round(value);}
    static byte[] StepMask(Bitmap image,float scale) {
      int left=Pixel((image.Width/scale-380)/2*scale+37*scale),top=Pixel(98*scale);
      var mask=new List<byte>();
      for(int y=top;y<top+Pixel(24*scale);y++)for(int x=left;x<left+Pixel(250*scale);x++) {
        Color c=image.GetPixel(x,y);
        mask.Add((byte)(c.R>180&&c.G>180&&c.B>180?c.A:0));
      }
      return mask.ToArray();
    }
    [STAThread] static void Main(string[] args) {
      Directory.CreateDirectory(args[0]);var rows=new List<object>();
      foreach(float scale in new[]{1f,1.25f,1.5f,1.75f,2f,2.5f,3f}) {
        var task=new TaskProgress {Task="打开 College Board 官网",Current="查看当前界面",Description="正在查看操作结果，确认下一步。",Status="working"};
        byte[] reference=null;int changed=0;
        foreach(int offset in new[]{0,1,2,3}) {
          int width=1600+offset,height=1000;
          using(var image=Frame.Draw(width,height,"Rufa 正在操作电脑","top",task,scale)) {
            var mask=StepMask(image,scale);
            if(reference==null)reference=mask;
            else for(int i=0;i<mask.Length;i++)if(mask[i]!=reference[i])changed++;
            if(offset!=0)continue;
            Rectangle lower=task.BackdropBounds(new Rectangle(0,0,width,height),"top",scale);
            var crop=new Rectangle(lower.Left-8,Pixel(22*scale)-8,lower.Width+16,lower.Bottom-Pixel(22*scale)+16);
            using(var card=image.Clone(crop,PixelFormat.Format32bppArgb)) {
              card.Save(Path.Combine(args[0],"transparent-"+scale+".png"));
              using(var visible=new Bitmap(card.Width,card.Height,PixelFormat.Format32bppArgb)) {
                using(var g=Graphics.FromImage(visible)) {g.Clear(Color.FromArgb(80,86,94));g.DrawImageUnscaled(card,0,0);}
                visible.Save(Path.Combine(args[0],"card-"+scale+".png"));
              }
            }
          }
        }
        int sampledGlyphPixels=0;
        foreach(byte alpha in reference)if(alpha>0)sampledGlyphPixels++;
        rows.Add(new {scale,shiftedGlyphPixels=changed,sampledGlyphPixels});
      }
      foreach(string position in new[]{"top","bottom"}) {
        float scale=1.5f;int width=1601,height=1000;
        var task=new TaskProgress {Task="打开 College Board 官网并查找需要的资料",Current="查看当前界面 · 执行键盘操作并核对页面上的任务结果，确认下一步操作",Description="正在查看操作结果，确认下一步。只在确认页面状态后继续执行，保留完整停止入口。",Status="working"};
        using(var image=Frame.Draw(width,height,"Rufa 正在操作电脑",position,task,scale)) {
          Rectangle lower=task.BackdropBounds(new Rectangle(0,0,width,height),position,scale);
          int top=lower.Top-Pixel(39*scale);
          var crop=new Rectangle(lower.Left-8,top-8,lower.Width+16,lower.Bottom-top+16);
          using(var card=image.Clone(crop,PixelFormat.Format32bppArgb))
          using(var visible=new Bitmap(card.Width,card.Height,PixelFormat.Format32bppArgb)) {
            using(var g=Graphics.FromImage(visible)) {g.Clear(Color.FromArgb(80,86,94));g.DrawImageUnscaled(card,0,0);}
            visible.Save(Path.Combine(args[0],"long-"+position+".png"));
          }
        }
      }
      File.WriteAllText(Path.Combine(args[0],"text-report.json"),new JavaScriptSerializer().Serialize(rows));
    }
  }
}
