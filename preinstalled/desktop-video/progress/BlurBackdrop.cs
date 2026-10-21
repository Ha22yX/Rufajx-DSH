// One DWM backdrop HWND covering only the lower card.
// No screen capture, bitmap background, focus changes, hooks, or input methods.

namespace DshTakeover {
  internal sealed class BlurBackdrop : Form {
    [StructLayout(LayoutKind.Sequential)] struct AccentPolicy { public int State, Flags, Color, Animation; }
    [StructLayout(LayoutKind.Sequential)] struct CompositionData { public int Attribute; public IntPtr Data; public int Size; }
    [StructLayout(LayoutKind.Sequential)] struct Margins { public int Left, Right, Top, Bottom; }
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate bool SetComposition(IntPtr window, ref CompositionData data);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    [DllImport("kernel32.dll", CharSet=CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr module, string name);
    [DllImport("dwmapi.dll")] static extern int DwmExtendFrameIntoClientArea(IntPtr window, ref Margins margins);
    [DllImport("dwmapi.dll")] static extern int DwmIsCompositionEnabled(out bool enabled);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr window,int attribute,ref int value,int size);
    [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr window,uint color,byte alpha,uint flags);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int width,int height,uint flags);
    [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr window,uint affinity);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window,int command);
    static readonly SetComposition SetAccent = ResolveAccent();
    bool configured;
    Rectangle lowerBounds;
    IntPtr foregroundFrame;
    bool remoteVisible=true;
    internal bool Applied { get; private set; }
    internal BlurBackdrop() {
      FormBorderStyle=FormBorderStyle.None; ShowInTaskbar=false; StartPosition=FormStartPosition.Manual;
      TopMost=true; BackColor=Color.Black; Text="Rufa task backdrop";
    }
    static SetComposition ResolveAccent() {
      IntPtr address=GetProcAddress(GetModuleHandle("user32.dll"),"SetWindowCompositionAttribute");
      return address==IntPtr.Zero?null:(SetComposition)Marshal.GetDelegateForFunctionPointer(address,typeof(SetComposition));
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
      get { var value=base.CreateParams; value.ExStyle|=0x80000|0x20|0x80|0x08000000; return value; }
    }
    protected override void OnPaintBackground(PaintEventArgs e) { e.Graphics.Clear(Color.Black); }
    protected override void WndProc(ref Message m) {
      if(m.Msg==0x84){m.Result=new IntPtr(-1);return;} // HTTRANSPARENT
      if(m.Msg==0x21){m.Result=new IntPtr(3);return;} // MA_NOACTIVATE
      if(m.Msg==0x031e)configured=false; // DWM composition changed; reapply next presentation.
      base.WndProc(ref m);
    }
    protected override void OnHandleDestroyed(EventArgs e){configured=false;Applied=false;base.OnHandleDestroyed(e);}
    bool Configure() {
      bool enabled;
      if(SetAccent==null||DwmIsCompositionEnabled(out enabled)!=0||!enabled)return false;
      // Accent blur ignores an HRGN mask, even when GetWindowRgn reports it
      // correctly. Let DWM round its own composition surface instead. An HRGN
      // or per-pixel alpha mask disables this native rounding.
      int round=2,noBorder=unchecked((int)0xfffffffe);
      if(DwmSetWindowAttribute(Handle,33,ref round,4)!=0)return false;
      if(DwmSetWindowAttribute(Handle,34,ref noBorder,4)!=0)return false;
      var margins=new Margins{Left=-1,Right=-1,Top=-1,Bottom=-1};
      if(DwmExtendFrameIntoClientArea(Handle,ref margins)!=0)return false;
      var policy=new AccentPolicy{State=3,Flags=0,Color=0,Animation=0};
      IntPtr data=Marshal.AllocHGlobal(Marshal.SizeOf(policy));
      try {
        Marshal.StructureToPtr(policy,data,false);
        var attribute=new CompositionData{Attribute=19,Data=data,Size=Marshal.SizeOf(policy)};
        return SetAccent(Handle,ref attribute);
      } finally { Marshal.FreeHGlobal(data); }
    }
    internal void Update(Rectangle lowerScreenBounds,int radiusPixels){
      // The native ~8px rounding fits within the visible 13px card with a 2px
      // inset. Hide its top corners behind the opaque control header.
      float scale=radiusPixels/13f;
      int inset=(int)Math.Ceiling(2*scale),overlap=(int)Math.Ceiling(8*scale);
      lowerBounds=new Rectangle(lowerScreenBounds.X+inset,lowerScreenBounds.Y-overlap,
        Math.Max(0,lowerScreenBounds.Width-inset*2),Math.Max(0,lowerScreenBounds.Height+overlap-inset));
    }
    internal void SetRemoteVisible(bool visible){remoteVisible=visible;if(IsHandleCreated)ApplyCapturePreference();}
    void ApplyCapturePreference(){if(!SetWindowDisplayAffinity(Handle,remoteVisible?0u:17u)&&!remoteVisible)SetWindowDisplayAffinity(Handle,1u);}
    internal void KeepBelow(IntPtr frame){foregroundFrame=frame;if(Applied&&frame!=IntPtr.Zero)SetWindowPos(Handle,frame,0,0,0,0,0x1|0x2|0x10|0x200);}
    internal bool Present(byte opacity){return TryPresent(foregroundFrame,lowerBounds,opacity);}
    // Call after the original layered frame has been presented/raised. Never
    // make this backdrop an owned child of the frame: that would put blur ABOVE text.
    bool TryPresent(IntPtr frame,Rectangle lowerScreenBounds,byte opacity) {
      if(frame==IntPtr.Zero||opacity==0||lowerScreenBounds.Width<1||lowerScreenBounds.Height<1){HideBackdrop();return false;}
      try {
        if(!configured){configured=Configure();if(!configured){HideBackdrop();return false;}}
        if(!SetLayeredWindowAttributes(Handle,0,opacity,2)){HideBackdrop();return false;}
        // Match the original indicator's capture preference; retry legacy exclusion on old Windows.
        ApplyCapturePreference();
        // The full-screen text/tint HWND stays immediately above this small backdrop.
        Applied=SetWindowPos(Handle,frame,lowerScreenBounds.X,lowerScreenBounds.Y,lowerScreenBounds.Width,lowerScreenBounds.Height,0x10|0x40|0x200);
        if(!Applied)HideBackdrop();return Applied;
      } catch(EntryPointNotFoundException){HideBackdrop();return false;}
    }
    internal void HideBackdrop(){if(IsHandleCreated)ShowWindow(Handle,0);Applied=false;}
  }
}
