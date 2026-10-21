// Rufajx presentation extension. Shares the native non-activating, click-through
// takeover surface and stop listener; it cannot authorize or execute input.
namespace DshTakeover {
  internal sealed class TaskProgress {
    internal string Task = "", Current = "", Description = "", Status = "working";
    static string Text(object value, int max) {
      string text = value as string ?? "";
      text = System.Text.RegularExpressions.Regex.Replace(text, @"[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]", " ").Trim();
      return text.Length > max ? text.Substring(0, max) : text;
    }
    internal static TaskProgress Read(Dictionary<string,object> command) {
      object raw;
      if (!command.TryGetValue("progress", out raw)) return null;
      var value = raw as Dictionary<string,object>;
      if (value == null) return null;
      var result = new TaskProgress();
      if (value.TryGetValue("task", out raw)) result.Task = Text(raw, 80);
      if (value.TryGetValue("currentStep", out raw)) result.Current = Text(raw, 100);
      if (value.TryGetValue("description", out raw)) result.Description = Text(raw, 120);
      if (value.TryGetValue("status", out raw)) result.Status = Text(raw, 16);
      if (result.Current.Length == 0) result.Current = result.Task;
      if (result.Current.Length == 0) return null;
      return result;
    }
    internal bool Terminal { get { return Status == "completed" || Status == "stopped" || Status == "failed"; } }
    internal string Identity { get { return Task + "\n" + Current + "\n" + Description + "\n" + Status; } }
    static Font PixelFont(float size, FontStyle style, float scale) {
      return new Font("Microsoft YaHei UI",(float)Math.Round(size*scale,MidpointRounding.AwayFromZero),style,GraphicsUnit.Pixel);
    }
    static StringFormat TextFormat(bool wrap) {
      return new StringFormat(StringFormat.GenericTypographic) { LineAlignment=StringAlignment.Near,
        Trimming=StringTrimming.EllipsisCharacter,FormatFlags=wrap?StringFormatFlags.LineLimit:StringFormatFlags.NoWrap };
    }
    static void Label(Graphics g, string text, Font font, Color color, RectangleF bounds, float scale, bool wrap = false) {
      if(String.IsNullOrEmpty(text)||bounds.Width<=0||bounds.Height<=0)return;
      // Shapes use logical coordinates; text is hinted once at its final physical
      // pixel size. Fractional card centering/DPI must not soften glyphs or their
      // baselines. No shadow, stroke, bitmap resize or subpixel color fringes.
      var state=g.Save();
      try {
        g.ResetTransform();
        g.TextRenderingHint=System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
        g.TextContrast=0;
        var pixels=Rectangle.FromLTRB((int)Math.Round(bounds.Left*scale),(int)Math.Round(bounds.Top*scale),
          (int)Math.Round(bounds.Right*scale),(int)Math.Round(bounds.Bottom*scale));
        using(var physical=PixelFont(font.Size,font.Style,scale))
        using(var format=TextFormat(wrap))
        using(var brush=new SolidBrush(color)) {
          float measured=g.MeasureString(text,physical,pixels.Width,format).Height;
          var area=new RectangleF(pixels.X,pixels.Y+(float)Math.Floor(Math.Max(0,pixels.Height-measured)/2),pixels.Width,pixels.Height);
          g.SetClip(pixels,System.Drawing.Drawing2D.CombineMode.Intersect);
          g.DrawString(text,physical,brush,area,format);
        }
      } finally {g.Restore(state);}
    }
    static float TextHeight(Graphics g,string text,float size,FontStyle style,float width,float scale,float line,float maximum) {
      var state=g.Save();
      try {
        g.ResetTransform();
        using(var font=PixelFont(size,style,scale))
        using(var format=TextFormat(true))
          return Math.Max(line,Math.Min(maximum,(float)Math.Ceiling(g.MeasureString(text,font,(int)Math.Floor(width*scale),format).Height/scale/line)*line));
      } finally {g.Restore(state);}
    }
    RectangleF Layout(Graphics g, int width, int height, string position, float scale, out float stepHeight, out float detailHeight) {
      float w = Math.Min(width / scale - 32,380);
      stepHeight = detailHeight = 0;
      if (w < 220 || height / scale < 190) return RectangleF.Empty;
      stepHeight=TextHeight(g,Current,16,FontStyle.Bold,w-109,scale,24,72);
      detailHeight=Description.Length==0?0:TextHeight(g,Description,13,FontStyle.Regular,w-51,scale,21,42);
      float h = Math.Max(140,39+12+17+8+stepHeight+5+detailHeight+15);
      return new RectangleF((width/scale-w)/2,position=="bottom" ? height/scale-h-22 : 22,w,h);
    }
    internal Rectangle BackdropBounds(Rectangle display, string position, float scale) {
      using (var bitmap = new Bitmap(1,1))
      using (var g = Graphics.FromImage(bitmap)) {
        g.ScaleTransform(scale,scale);
        float step,detail; var card = Layout(g,display.Width,display.Height,position,scale,out step,out detail);
        if(card.IsEmpty)return Rectangle.Empty;
        return new Rectangle(display.X+(int)Math.Round(card.X*scale),display.Y+(int)Math.Round((card.Y+39)*scale),
          (int)Math.Round(card.Width*scale),(int)Math.Round((card.Height-39)*scale));
      }
    }
    internal void Draw(Graphics g, int width, int height, string position, float scale) {
      var saved = g.Save(); g.ScaleTransform(scale,scale);
      // ClearType assumes an opaque destination and leaves colored fringes on
      // a per-pixel layered window. Use grayscale, pixel-hinted antialiasing.
      g.TextRenderingHint=System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
      float stepHeight,detailHeight; var card = Layout(g,width,height,position,scale,out stepHeight,out detailHeight);
      if(card.IsEmpty){g.Restore(saved);return;}
      float x=card.X,y=card.Y,w=card.Width,h=card.Height;
      using (var small = new Font("Microsoft YaHei UI",12,FontStyle.Regular,GraphicsUnit.Pixel))
      using (var header = new Font("Microsoft YaHei UI",13,FontStyle.Regular,GraphicsUnit.Pixel))
      using (var strong = new Font("Microsoft YaHei UI",16,FontStyle.Bold,GraphicsUnit.Pixel)) {
        float stepWidth = w-109;
        Color accent = Status=="completed" ? Color.FromArgb(225,234,246) : Terminal ? Color.FromArgb(255,224,180) : Color.FromArgb(215,235,255);
        using (var shape = Frame.Rounded(new RectangleF(x,y,w,h),13)) {
          // A dark translucent tint keeps secondary labels readable even over a
          // white application. The desktop is still live and visible through it.
          // Fill the rounded path itself for antialiased corners, not a rectangular
          // fill constrained by GDI's integer clipping region.
          using (var lower = new SolidBrush(Color.FromArgb(160,20,26,34))) g.FillPath(lower,shape);
          var clip = g.Save(); g.SetClip(new RectangleF(x,y,w,39));
          using (var top = new SolidBrush(Color.FromArgb(37,44,53))) g.FillPath(top,shape);
          g.Restore(clip);
          using (var border = new Pen(Color.FromArgb(20,119,125,135),1)) g.DrawPath(border,shape);
        }
        using (var pen = new Pen(Color.FromArgb(157,198,255),1.3f)) {
          g.DrawRectangle(pen,x+13,y+12,15,10);
          g.DrawLine(pen,x+20.5f,y+22,x+20.5f,y+26); g.DrawLine(pen,x+17,y+26,x+24,y+26);
        }
        // Native "completed" means the run ended, not that its business goal was achieved.
        string title = Status=="completed" ? "Rufa 电脑操作已结束" : Status=="failed" ? "Rufa 电脑操作未完成" : Terminal ? "Rufa 已停止电脑操作" : "Rufa 正在操作电脑";
        Label(g,title,header,Color.FromArgb(225,234,247),new RectangleF(x+37,y+8,w-116,23),scale);
        var stopColor = Terminal ? Color.FromArgb(116,126,140) : Color.FromArgb(203,213,227);
        using (var key = Frame.Rounded(new RectangleF(x+w-72,y+11,28,18),3))
        using (var pen = new Pen(Terminal ? Color.FromArgb(65,75,90) : Color.FromArgb(98,113,134),1)) g.DrawPath(pen,key);
        Label(g,"Esc",small,stopColor,new RectangleF(x+w-68,y+10,25,20),scale);
        Label(g,"停止",small,stopColor,new RectangleF(x+w-38,y+10,32,20),scale);
        Label(g,Task,header,Color.FromArgb(225,231,239),new RectangleF(x+37,y+50,w-51,20),scale);
        float sy = y+76;
        using (var pen = new Pen(accent,1.3f)) {
          g.DrawEllipse(pen,x+13,sy+3,15,15);
          if (Status=="completed") g.DrawLine(pen,x+17,sy+10.5f,x+24,sy+10.5f);
          else if (Terminal) g.DrawRectangle(pen,x+18,sy+8,5,5);
          else { g.DrawEllipse(pen,x+17,sy+3,7,15); g.DrawLine(pen,x+13,sy+10.5f,x+28,sy+10.5f); }
        }
        Label(g,Current,strong,Color.White,new RectangleF(x+37,sy,stepWidth,stepHeight),scale,true);
        using (var dot = new SolidBrush(accent)) g.FillEllipse(dot,x+w-62,sy+9,4,4);
        string status = Status=="completed" ? "已结束" : Status=="failed" ? "未完成" : Terminal ? "已停止" : "进行中";
        Label(g,status,header,accent,new RectangleF(x+w-53,sy,46,24),scale);
        Label(g,Description,header,Color.FromArgb(242,245,249),new RectangleF(x+37,sy+stepHeight+5,w-51,detailHeight),scale,true);
      }
      g.Restore(saved);
    }
  }
}
