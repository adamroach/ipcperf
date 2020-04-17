#!/usr/bin/perl

$undname = '/c/Program Files (x86)/Microsoft Visual Studio/2019/Community/VC/Tools/MSVC/14.24.28314/bin/Hostx64/x64/undname.exe';

@profile = <~/Downloads/Firefox*json.gz>;
if (@profile > 1) {
  die ("More than one profile in Downloads directory");
}
if (!@profile) {
  die ("Cannot find profile in Downloads directory");
}

$profile = shift @profile;
$profile =~ /(Firefox.*json)/ || die;
$uncompressed_profile = $1;

$profile =~ /(\d{4}-\d{2}-\d{2}) (\d{2}).(\d{2})/ || die "Cannot extract date/time";
$outdir = "$1-$2-$3";

mkdir($outdir) || warn $!;

foreach $log (</tmp/channel-log*.log>) {
  print "$log\n";
  system('mv',$log,$outdir);
}

system('cp',$profile,$outdir);
system('gunzip',$outdir.'/'.$uncompressed_profile.'.gz');
system("'$undname' '$outdir/$uncompressed_profile' > '$outdir/tmp.json'");
system('mv',"$outdir/tmp.json","$outdir/$uncompressed_profile");

system('mv',$profile,'bak');
