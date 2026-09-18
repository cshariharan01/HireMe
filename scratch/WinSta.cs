using System;
using System.Text;
using System.Runtime.InteropServices;

public class WinSta {
    [DllImport("user32.dll")]
    public static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll")]
    public static extern IntPtr GetThreadDesktop(int dwThreadId);
    [DllImport("kernel32.dll")]
    public static extern int GetCurrentThreadId();
    [DllImport("user32.dll")]
    public static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, StringBuilder pvInfo, int nLength, out int lpnLengthNeeded);

    public static void Main() {
        var hSta = GetProcessWindowStation();
        var hDesk = GetThreadDesktop(GetCurrentThreadId());
        var sb1 = new StringBuilder(256);
        int len1;
        GetUserObjectInformation(hSta, 2, sb1, 256, out len1);
        var sb2 = new StringBuilder(256);
        int len2;
        GetUserObjectInformation(hDesk, 2, sb2, 256, out len2);
        Console.WriteLine("WindowStation: '" + sb1.ToString() + "', Desktop: '" + sb2.ToString() + "'");
    }
}
